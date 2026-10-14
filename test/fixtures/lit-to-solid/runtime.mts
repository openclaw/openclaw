import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire, stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { convertLitToSolid } from "../../../scripts/codemods/lit-to-solid.mts";

const require = createRequire(new URL("../../../ui/package.json", import.meta.url));
const compiler: {
  transform(source: string, options: { filename: string; moduleName: string }): { code: string };
} = require("@solidjs/compiler");
const webUrl = pathToFileURL(require.resolve("@solidjs/web")).href;
const coreUrl = pathToFileURL(require.resolve("solid-js")).href;
const output = process.argv[2];
assert.ok(output, "Provide the task-owned output module path");
const dom = new JSDOM("<!doctype html><body></body>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  DocumentFragment: dom.window.DocumentFragment,
  Text: dom.window.Text,
});
const source = `
import { html, nothing, type TemplateResult } from "lit";
import { createSignal, flush } from "solid-js";
const [visible, setVisible] = createSignal(true);
const pending: unknown = Promise.resolve(false);
const String = () => "wrong";
const Array = { from: () => { throw Error("captured Array"); } };
const Symbol = { iterator: "wrong" };
export let unsafeCalls = 0;
export const rawChild = () => { unsafeCalls++; return "called"; };
const holder = { child: {} };
Object.assign(holder, { child: rawChild });
export const node = document.createElement("i");
node.textContent = "node";
function projected(draw: () => TemplateResult) { return html\`\${draw()}\`; }
export function View() {
  const part = html\`\${visible() ? html\`<b>visible</b>\` : nothing}\`;
  const presence = html\`\${pending ? "waiting" : "idle"}\`;
  return html\`<div title data-code=\${(1, 2)} class=\${["a", "b"]} ?data-selected=\${visible()}>\${part}\${presence}<span>\${[true, false, 123n]}</span><span>\${new Date(0)}</span>\${node}<span>\${(1, 2)}</span><span>\${holder.child}</span>\${projected(() => html\`\${true ? html\`<em>projected</em>\` : nothing}\`)}</div>\`;
}
export { setVisible, flush };
`;
const result = convertLitToSolid(source, "runtime.ts");
assert.deepEqual(result.diagnostics, []);
const compiled = compiler.transform(result.code, { filename: "runtime.tsx", moduleName: webUrl });
fs.writeFileSync(
  output,
  stripTypeScriptTypes(compiled.code).replace(
    /from ["']solid-js["']/gu,
    `from ${JSON.stringify(coreUrl)}`,
  ),
);
try {
  const fixture = await import(pathToFileURL(output).href);
  const { render } = await import(webUrl);
  const root = document.createElement("main");
  document.body.append(root);
  const dispose = render(() => fixture.View(), root);
  try {
    const tail = `waitingtruefalse123${String(new Date(0))}node2${String(fixture.rawChild)}projected`;
    assert.equal(root.textContent, `visible${tail}`);
    assert.equal(root.querySelector("div")?.className, "a,b");
    assert.equal(root.querySelector("div")?.getAttribute("title"), "");
    assert.equal(root.querySelector("div")?.getAttribute("data-code"), "2");
    assert.equal(root.querySelector("div")?.getAttribute("data-selected"), "");
    assert.equal(root.querySelector("i"), fixture.node);
    assert.equal(fixture.unsafeCalls, 0);
    await Promise.resolve();
    fixture.flush();
    assert.equal(root.textContent, `visible${tail}`);
    fixture.setVisible(false);
    fixture.flush();
    assert.equal(root.textContent, tail);
    assert.equal(root.querySelector("div")?.hasAttribute("data-selected"), false);
    fixture.setVisible(true);
    fixture.flush();
    assert.equal(root.textContent, `visible${tail}`);
    assert.equal(root.querySelector("i"), fixture.node);
    assert.equal(fixture.unsafeCalls, 0);
    console.log("compiled runtime: composed Show, primitive/object text, and node identity passed");
  } finally {
    dispose();
  }
} finally {
  fs.unlinkSync(output);
  dom.window.close();
}
