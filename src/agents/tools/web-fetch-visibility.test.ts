import { describe, expect, it, vi } from "vitest";
import { stripInvisibleUnicode } from "../../infra/unicode-visibility.js";
import { sanitizeHtml } from "./web-fetch-visibility.js";

async function expectVisible(html: string, visible = ["Visible sibling"]) {
  const result = await sanitizeHtml(`<p>Visible prefix</p>${html}`);
  expect(result).toContain("Visible prefix");
  expect(result).not.toContain("Secret");
  for (const text of visible) {
    expect(result).toContain(text);
  }
}

describe("sanitizeHtml", () => {
  it("filters real metadata and hidden ordinary names without removing the visible sibling", async () => {
    const html =
      '<meta content="Secret metadata"><meta\u00a0 hidden>Secret body</meta\u00a0><p>Visible sibling</p>';
    expect(await sanitizeHtml(html)).toBe("<p>Visible sibling</p>");
  });

  it("reuses compiled visibility matchers across styled elements", async () => {
    const html = Array.from(
      { length: 256 },
      (_, index) => `<p style="color:rgb(12,34,56)">Visible ${index}</p>`,
    ).join("");
    const NativeRegExp = globalThis.RegExp;
    using regexpConstructor = vi.spyOn(globalThis, "RegExp").mockImplementation(function (
      pattern?: string | RegExp,
      flags?: string,
    ) {
      return Reflect.construct(NativeRegExp, [pattern, flags]);
    });

    const result = await sanitizeHtml(html);
    expect(result).toContain("Visible 0");
    expect(result).toContain("Visible 255");
    expect(regexpConstructor).not.toHaveBeenCalled();
  });

  it.each([
    "display:none",
    "visibility:hidden",
    "opacity:0",
    "font-size:0px",
    "text-indent:-9999px",
    "color:transparent",
    "color:rgba(0,0,0,0.0)",
    "color:hsla(0,0%,0%,0)",
    "transform:scale(0)",
    "transform:scale(1, 0)",
    "transform:scaleX(-0.0)",
    "transform:scaleY(0%)",
    "transform:scale3d(0%, 100%, 100%)",
    "transform:scale3d(100%, 0%, 100%)",
    "transform:rotate(30deg) scale(1, 0e2)",
    "transform:translateX(-9999px)",
    "transform:translateY(-9999px)",
    "width:0;height:0;overflow:hidden",
    "left:-9999px",
    "top:-9999px",
    "clip-path:inset(50%)",
  ])("strips elements hidden by %s", async (style) => {
    const result = await sanitizeHtml(`<p>Visible</p><div style="${style}">Hidden</div>`);
    expect(result).toContain("Visible");
    expect(result).not.toContain("Hidden");
  });

  it.each([
    "scale(0.5, 0.5)",
    "scale3d(100%, 100%, 0%)",
    "scaleZ(0)",
    "scale(0, 0, 0)",
    "scale3d(0, 0)",
    "scaleX(0, 0)",
    "scale(0, invalid)",
  ])("preserves visible or invalid transform %s", async (transform) => {
    const html = `<p style="transform:${transform}">Visible</p>`;
    expect(await sanitizeHtml(html)).toBe(html);
  });

  it.each(["hidden"])("strips elements with the %s class", async (className) => {
    const result = await sanitizeHtml(`<p>Main</p><span class="${className}">Hidden</span>`);
    expect(result).not.toContain("Hidden");
  });

  it.each([
    "<meta\u00a0><p>Visible inside</p></meta\u00a0><p>Visible sibling</p>",
    '<p>Show</p><div style="clip-path:inset(0%)">Visible</div>',
    '<p>Main</p><div class="un-hidden">Should be visible</div>',
    '<html><body aria-label="Show hidden replies"><h1>Thread</h1><p>Every reply in this thread.</p></body></html>',
    '<div hidden@click="noop">Visible article</div>',
    "<p>Unclosed <div>Nested",
  ])("preserves visible markup: %s", async (html) => {
    expect(await sanitizeHtml(html)).toBe(html);
  });

  it.each([
    '[class]="state" aria-hidden="true"',
    '[style] = "state" style="display:none"',
    '@click="noop" hidden',
    '(click)="noop" class="hidden"',
  ])("reads visibility after framework attributes: %s", async (attrs) => {
    await expectVisible(`<div ${attrs}>Secret</div><p>Visible sibling</p>`);
  });

  it.each([
    "<ul><li hidden><ul><li>A<li>B</li></ul>Secret</li></ul><p>Visible sibling</p>",
    "<p hidden>Before</div>Secret</p><p>Visible sibling</p>",
    '<form><input type="hidden" value="Secret"/></form><p>Visible sibling</p>',
    "<div hidden><div>Secret nested</div>Secret tail</div><p>Visible sibling</p>",
    "<script.foo><p hidden>Secret data</p></script.foo><p>Visible sibling</p>",
    "<ul><li hidden>Secret outer<ul><li>Secret inner</li></ul>Secret tail</li><li>Visible sibling</li></ul>",
    "<ul><li hidden>Secret outer<svg><foreignObject><li>Secret inner</li></foreignObject></svg>Secret tail</li><li>Visible sibling</li></ul>",
    "<div hidden>Secret before</span>Secret after</div><p>Visible sibling</p>",
    "<table><tr hidden><td>Secret<table><tr><td>Secret inner</td></tr></table>Secret tail</td></tr><tr><td>Visible sibling</td></tr></table>",
    "<p hidden>Secret before<script><p>Secret data</p></script>Secret tail</p><p>Visible sibling</p>",
    "<p hidden>Secret before<script><!--<script></script><p>Secret data</p>--></script>Secret tail</p><p>Visible sibling</p>",
    "<p hidden>Secret before<script/><p>Secret data</p></script>Secret tail</p><p>Visible sibling</p>",
    '<math><title hidden data-note="Secret"/><mtext>Visible sibling</mtext></math>',
    "<p hidden>Secret before<thead>Secret data</thead>Secret tail</p><p>Visible sibling</p>",
    "<datalist><option hidden>Secret outer<span><option>Secret inner</option></span>Secret tail</option></datalist><p>Visible sibling</p>",
    "<math><mtext><p hidden>Secret before<script><p>Secret data</p></script>Secret tail</p><p>Visible sibling</p></mtext></math>",
  ])("preserves the hidden owner across nested and unmatched tags: %s", async (html) => {
    await expectVisible(html);
  });

  it.each([
    '<ul><li class="d-none">Secret</ul><p>Visible sibling</p>',
    "<ul><li hidden><span>Secret<li>Visible sibling</ul>",
    "<p hidden>Secret<p>Visible sibling</p>",
    "<dl><dt hidden>Secret<dd>Visible sibling</dd></dl>",
    "<table><tr><td hidden>Secret<td>Visible sibling</td></tr></table>",
    "<table><tr hidden><td>Secret<tr><td>Visible sibling</td></tr></table>",
    "<select><optgroup><option hidden>Secret<optgroup><option>Visible sibling</option></optgroup></select>",
    "<dl><dd hidden>Secret</dl><p>Visible sibling</p>",
    "<table><tr><td><p hidden>Secret</table><p>Visible sibling</p>",
    "<datalist><option hidden>Secret<option>Visible sibling</option></datalist>",
  ])("closes optional elements only within their owning scope: %s", async (html) => {
    await expectVisible(html + "<p>Article after</p>", ["Visible sibling", "Article after"]);
  });

  it("keeps an unfinished script region hidden", async () => {
    await expectVisible(`<p>Visible prefix</p><p hidden>Secret<script><p>Secret data`, [
      "Visible prefix",
    ]);
  });
});

describe("stripInvisibleUnicode", () => {
  it("strips directional overrides (LRO, RLO, PDF, etc.)", () => {
    expect(stripInvisibleUnicode("\u202AHello\u202E")).toBe("Hello");
  });
});
