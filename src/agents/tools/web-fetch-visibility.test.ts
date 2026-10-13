// web_fetch visibility tests cover hidden HTML and invisible Unicode stripping
// before extracted content reaches the model.
import { describe, expect, it, vi } from "vitest";
import { stripInvisibleUnicode } from "../../infra/unicode-visibility.js";
import { sanitizeHtml } from "./web-fetch-visibility.js";

describe("sanitizeHtml", () => {
  it.each(["meta\u00a0"])(
    "retains visible contents in the complete ordinary name %s",
    async (name) => {
      const html = `<${name}><p>Visible inside</p></${name}><p>Visible sibling</p>`;
      expect(await sanitizeHtml(html)).toBe(html);
    },
  );

  it("filters real metadata and hidden ordinary names without removing the visible sibling", async () => {
    const html =
      '<meta content="Secret metadata"><meta\u00a0 hidden>Secret body</meta\u00a0><p>Visible sibling</p>';
    expect(await sanitizeHtml(html)).toBe("<p>Visible sibling</p>");
  });

  it.each(["script.foo"])(
    "checks hidden descendants when %s is not a raw-text element",
    async (name) => {
      const html = `<${name}><p hidden>Secret data</p></${name}><p>Visible sibling</p>`;
      const result = await sanitizeHtml(html);
      expect(result).not.toContain("Secret data");
      expect(result).toContain("Visible sibling");
    },
  );

  it("reuses compiled visibility matchers across styled elements", async () => {
    const styledElements = 256;
    const html = Array.from(
      { length: styledElements },
      (_, index) => `<p style="color:rgb(12,34,56)">Visible ${index}</p>`,
    ).join("");
    const NativeRegExp = globalThis.RegExp;
    const regexpConstructor = vi.spyOn(globalThis, "RegExp").mockImplementation(function (
      pattern?: string | RegExp,
      flags?: string,
    ) {
      return Reflect.construct(NativeRegExp, [pattern, flags]);
    });

    try {
      const result = await sanitizeHtml(html);
      expect(result).toContain("Visible 0");
      expect(result).toContain(`Visible ${styledElements - 1}`);
      expect(regexpConstructor).not.toHaveBeenCalled();
    } finally {
      regexpConstructor.mockRestore();
    }
  });

  it.each([
    "display:none",
    "visibility:hidden",
    "opacity:0",
    "font-size:0px",
    "text-indent:-9999px",
    "color:transparent",
    "color:rgba(0,0,0,0)",
    "color:rgba(0,0,0,0.0)",
    "color:hsla(0,0%,0%,0)",
    "transform:scale(0)",
    "transform:translateX(-9999px)",
    "transform:translateY(-9999px)",
    "width:0;height:0;overflow:hidden",
    "left:-9999px",
    "top:-9999px",
    "clip-path:inset(100%)",
    "clip-path:inset(50%)",
  ])("strips elements hidden by %s", async (style) => {
    const result = await sanitizeHtml(`<p>Visible</p><div style="${style}">Hidden</div>`);
    expect(result).toContain("Visible");
    expect(result).not.toContain("Hidden");
  });

  it("does not strip clip-path:inset(0%) elements", async () => {
    const html = '<p>Show</p><div style="clip-path:inset(0%)">Visible</div>';
    const result = await sanitizeHtml(html);
    expect(result).toContain("Visible");
  });

  it.each(["sr-only", "visually-hidden", "d-none", "hidden"])(
    "strips elements with the %s class",
    async (className) => {
      const result = await sanitizeHtml(`<p>Main</p><span class="${className}">Hidden</span>`);
      expect(result).not.toContain("Hidden");
    },
  );

  it("does not strip elements with hidden as substring of class name", async () => {
    const html = '<p>Main</p><div class="un-hidden">Should be visible</div>';
    const result = await sanitizeHtml(html);
    expect(result).toContain("Should be visible");
  });

  it("strips input type=hidden", async () => {
    const html = '<form><input type="hidden" value="csrf-token-secret"/></form>';
    const result = await sanitizeHtml(html);
    expect(result).not.toContain("csrf-token-secret");
  });

  it("drops nested hidden same-name elements without leaking trailing hidden text", async () => {
    // Malformed hidden regions are prompt-injection territory; nested tags must
    // not leak trailing hidden text after the inner close tag.
    const html = "<p>Visible</p><div hidden><div>Nested hidden</div>Still hidden</div><p>Shown</p>";
    const result = await sanitizeHtml(html);
    expect(result).toContain("Visible");
    expect(result).toContain("Shown");
    expect(result).not.toContain("Nested hidden");
    expect(result).not.toContain("Still hidden");
  });

  it("keeps the page when a body attribute value mentions hidden", async () => {
    const html =
      '<html><body aria-label="Show hidden replies"><h1>Thread</h1><p>Every reply in this thread.</p></body></html>';
    const result = await sanitizeHtml(html);
    expect(result).toContain("Thread");
    expect(result).toContain("Every reply in this thread.");
  });

  it("still strips an optional-end-tag hidden element closed by its container", async () => {
    const html = '<ul><li class="d-none">Dropped nav item</ul><p>Kept body</p>';
    const result = await sanitizeHtml(html);
    expect(result).not.toContain("Dropped nav item");
    expect(result).toContain("Kept body");
  });

  it.each(['[class]="state" aria-hidden="true"', '[style] = "state" style="display:none"'])(
    "reads visibility after framework attributes: %s",
    async (attrs) => {
      const result = await sanitizeHtml(`<div ${attrs}>Secret</div><p>Visible sibling</p>`);
      expect(result).not.toContain("Secret");
      expect(result).toContain("Visible sibling");
    },
  );

  it.each(['hidden@click="noop"'])("keeps unrelated complete attributes: %s", async (attrs) => {
    expect(await sanitizeHtml(`<div ${attrs}>Visible article</div>`)).toContain("Visible article");
  });

  it.each([
    "<ul><li hidden>Secret outer<ul><li>Secret inner</li></ul>Secret tail</li><li>Visible sibling</li></ul>",
    "<ul><li hidden>Secret outer<svg><foreignObject><li>Secret inner</li></foreignObject></svg>Secret tail</li><li>Visible sibling</li></ul>",
    "<div hidden>Secret before</span>Secret after</div><p>Visible sibling</p>",
  ])("preserves the hidden owner across nested and unmatched tags: %s", async (html) => {
    const result = await sanitizeHtml(html);
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it.each(["ul"])("closes omitted list items within their %s owner", async (list) => {
    const result = await sanitizeHtml(
      `<${list}><li hidden><span>Secret<li>Visible sibling</${list}><p>Article after</p>`,
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
    expect(result).toContain("Article after");
  });

  it.each([
    "<p hidden>Secret<p>Visible sibling</p>",
    "<dl><dt hidden>Secret<dd>Visible sibling</dd></dl>",
    "<table><tr><td hidden>Secret<td>Visible sibling</td></tr></table>",
    "<table><tr hidden><td>Secret<tr><td>Visible sibling</td></tr></table>",
    "<select><optgroup><option hidden>Secret<optgroup><option>Visible sibling</option></optgroup></select>",
    "<dl><dd hidden>Secret</dl><p>Visible sibling</p>",
    "<table><tr><td><p hidden>Secret</table><p>Visible sibling</p>",
  ])("closes optional elements only within their owning scope: %s", async (html) => {
    const result = await sanitizeHtml(html + "<p>Article after</p>");
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
    expect(result).toContain("Article after");
  });

  it.each([
    "<table><tr hidden><td>Secret<table><tr><td>Secret inner</td></tr></table>Secret tail</td></tr><tr><td>Visible sibling</td></tr></table>",
  ])("keeps hidden ancestors across optional-element families: %s", async (html) => {
    const result = await sanitizeHtml(html);
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it.each(["script"])("keeps %s data inside its hidden paragraph", async (tag) => {
    const result = await sanitizeHtml(
      `<p hidden>Secret before<${tag}><p>Secret data</p></${tag}>Secret tail</p><p>Visible sibling</p>`,
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it.each(["script"])("keeps an unfinished %s region hidden", async (tag) => {
    const result = await sanitizeHtml(
      `<p>Visible prefix</p><p hidden>Secret<${tag}><p>Secret data`,
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible prefix");
  });

  it.each([
    "<p hidden>Secret before<script><!--<script></script><p>Secret data</p>--></script>Secret tail</p><p>Visible sibling</p>",
  ])("keeps double-escaped script data in its hidden owner: %s", async (html) => {
    const result = await sanitizeHtml(html);
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it.each(["script"])("ignores the HTML %s opener slash for opaque text", async (tag) => {
    const result = await sanitizeHtml(
      `<p hidden>Secret before<${tag}/><p>Secret data</p></${tag}>Secret tail</p><p>Visible sibling</p>`,
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it("preserves self-closing foreign text elements", async () => {
    const result = await sanitizeHtml(
      '<math><title hidden data-note="Secret"/><mtext>Visible sibling</mtext></math>',
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it.each(["thead"])(
    "ignores misplaced %s starts when resolving a hidden paragraph",
    async (tag) => {
      const result = await sanitizeHtml(
        `<p hidden>Secret before<${tag}>Secret data</${tag}>Secret tail</p><p>Visible sibling</p>`,
      );
      expect(result).not.toContain("Secret");
      expect(result).toContain("Visible sibling");
    },
  );

  it.each(["option"])("keeps datalist %s descendants inside the hidden owner", async (tag) => {
    const result = await sanitizeHtml(
      `<datalist><${tag} hidden>Secret outer<span><${tag}>Secret inner</${tag}></span>Secret tail</${tag}></datalist><p>Visible sibling</p>`,
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it("keeps ordinary omitted datalist option siblings", async () => {
    const result = await sanitizeHtml(
      "<datalist><option hidden>Secret<option>Visible sibling</option></datalist><p>Article after</p>",
    );
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
    expect(result).toContain("Article after");
  });

  it.each([
    "<math><mtext><p hidden>Secret before<script><p>Secret data</p></script>Secret tail</p><p>Visible sibling</p></mtext></math>",
  ])("keeps foreign markup and HTML integration-point text distinct: %s", async (html) => {
    const result = await sanitizeHtml(html);
    expect(result).not.toContain("Secret");
    expect(result).toContain("Visible sibling");
  });

  it("handles malformed HTML gracefully", async () => {
    const html = "<p>Unclosed <div>Nested";
    await expect(sanitizeHtml(html)).resolves.toContain("Unclosed");
  });
});

describe("stripInvisibleUnicode", () => {
  it("strips directional overrides (LRO, RLO, PDF, etc.)", () => {
    // Directional controls can make visible text render differently from the
    // byte sequence the model sees.
    const text = "\u202AHello\u202E";
    expect(stripInvisibleUnicode(text)).toBe("Hello");
  });
});
