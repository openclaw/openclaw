import { describe, expect, it } from "vitest";
import { decodeHtmlEntities, escapeHtml } from "./text-utility-runtime.js";

describe("escapeHtml", () => {
  it("escapes five HTML-sensitive characters and existing entity markers", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml("already &amp; escaped")).toBe("already &amp;amp; escaped");
  });
});

describe("decodeHtmlEntities", () => {
  it("exposes single-pass HTML5 decoding to plugins", () => {
    expect(decodeHtmlEntities("&copy; &amp;lt; &#128512; &#xD800;")).toBe("© &lt; 😀 &#xD800;");
  });
});
