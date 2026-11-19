import assert from 'node:assert/strict';
import { readFile } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repository = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(repository, 'target/demo');
const types = { '.css': 'text/css', '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/demo.html' : pathname));
  if (!file.startsWith(root + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  readFile(file, (error, content) => {
    if (error) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    response.end(content);
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const base = process.env.DEMO_URL ?? `http://127.0.0.1:${address.port}/demo.html`;
const local = process.env.DEMO_URL === undefined;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
  args: ['--enable-webgl', '--use-angle=swiftshader']
});
const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
const page = await context.newPage();
const errors = [];
const requests = [];
page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('response', response => {
  requests.push(response.url());
  if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
});

await page.goto(base);
await page.waitForFunction(() => document.querySelector('#status')?.textContent === 'Ready to fetch the static todo list.');
assert.equal(await page.locator('option').count(), 7);
assert.equal(await page.locator('.copy-button').count(), 2);

await page.locator('#run-demo').click();
await page.waitForFunction(() => document.querySelectorAll('#todo-list li').length === 4);
assert.equal(await page.locator('#todo-list li.completed').count(), 2);
assert.match(await page.locator('#status').innerText(), /4 todos fetched by TeaVM/);

await page.locator('#demo-mode').selectOption('svg');
await page.locator('#demo-output svg').waitFor();
assert.equal(await page.locator('#demo-output svg rect').count(), 3);

await page.locator('#demo-mode').selectOption('canvas');
await page.locator('#diagram-canvas').waitFor();
assert.ok(await page.locator('#diagram-canvas').evaluate(canvas => canvas.toDataURL().length > 10000));

await page.locator('#demo-mode').selectOption('webgl');
await page.locator('#webgl-canvas').waitFor();
const webgl = await page.locator('#webgl-canvas').evaluate(canvas => {
  document.querySelector('#run-demo').click();
  canvas = document.querySelector('#webgl-canvas');
  const gl = canvas.getContext('webgl');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  const background = [pixels[0], pixels[1], pixels[2]];
  let colored = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] !== background[0] || pixels[i + 1] !== background[1] || pixels[i + 2] !== background[2]) colored++;
  }
  return { colored, error: gl.getError(), version: gl.getParameter(gl.VERSION) };
});
assert.ok(webgl.colored > 5000, `WebGL colored pixels: ${webgl.colored}`);
assert.equal(webgl.error, 0);
assert.match(webgl.version, /WebGL/);
assert.match(await page.locator('#status').innerText(), /@webgl through the WebGL host function/);
await page.screenshot({ path: 'target/teavm-webgl-demo.png', fullPage: true });

await page.locator('#demo-mode').selectOption('animation');
await page.locator('#animation-canvas').waitFor();
await page.waitForTimeout(100);
const frame1 = await page.locator('#animation-canvas').evaluate(canvas => canvas.toDataURL());
await page.waitForTimeout(150);
const frame2 = await page.locator('#animation-canvas').evaluate(canvas => canvas.toDataURL());
assert.notEqual(frame1, frame2, 'requestAnimationFrame changes canvas frames');
await page.locator('#animation-canvas').hover({ position: { x: 110, y: 90 } });
await page.waitForTimeout(100);
const pointerFrame = await page.locator('#animation-canvas').evaluate(canvas => canvas.toDataURL());
assert.notEqual(frame2, pointerFrame, 'pointer event changes the drawing');
await page.locator('#animation-toggle').click();
assert.equal(await page.locator('#animation-toggle').innerText(), 'Resume animation');
assert.match(await page.locator('#status').innerText(), /Animation paused/);
await page.waitForTimeout(50);
const paused1 = await page.locator('#animation-canvas').evaluate(canvas => canvas.toDataURL());
await page.waitForTimeout(150);
const paused2 = await page.locator('#animation-canvas').evaluate(canvas => canvas.toDataURL());
assert.equal(paused1, paused2, 'paused animation stops drawing');
await page.locator('#animation-toggle').press('Space');
assert.equal(await page.locator('#animation-toggle').innerText(), 'Pause animation');
assert.match(await page.locator('#status').innerText(), /Animation resumed/);

await page.locator('#demo-mode').selectOption('data-shapes');
await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('drawing-shapes.json and rendered'));
assert.match(await page.locator('#status').innerText(), /10 commands/);
const shapes = await page.locator('#data-canvas').evaluate(canvas => canvas.toDataURL());
assert.ok(shapes.length > 10000);

await page.locator('#demo-mode').selectOption('data-chart');
await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('drawing-chart.json and rendered'));
assert.match(await page.locator('#status').innerText(), /12 commands/);
const chart = await page.locator('#data-canvas').evaluate(canvas => canvas.toDataURL());
assert.notEqual(shapes, chart, 'data files produce different drawings');
assert.ok(requests.some(url => url.endsWith('/drawing-shapes.json')));
assert.ok(requests.some(url => url.endsWith('/drawing-chart.json')));
await page.locator('#run-demo').click();
await page.waitForFunction(() => document.querySelector('#run-demo')?.disabled === false);
assert.ok(requests.filter(url => url.endsWith('/drawing-chart.json')).length >= 2);
await page.screenshot({ path: 'target/teavm-json-demo.png', fullPage: true });

const copyButton = page.locator('.copy-button').nth(1);
await copyButton.click();
await page.waitForFunction(() => document.querySelectorAll('.copy-button')[1]?.textContent === 'Copied!');
assert.equal(await copyButton.getAttribute('aria-label'), 'Code copied to clipboard');
if (local) {
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clipboard, /"commands"/);
  assert.match(clipboard, /"type": "circle"/);
}

await page.locator('#demo-mode').selectOption('todo');
await page.locator('#run-demo').click();
await page.waitForFunction(() => document.querySelectorAll('#todo-list li').length === 4);
assert.deepEqual(errors, []);
console.log(JSON.stringify({ options: 7, todos: 4, webgl, animation: 'frames, pointer, pause, Space verified', jsonDrawings: [10, 12], copyButtons: 2, errors }, null, 2));
await browser.close();
server.close();
