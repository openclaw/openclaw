// web_fetch extraction tests cover HTML entity decoding into model-facing text.
import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "./web-fetch-utils.js";

describe("web-fetch-utils htmlToMarkdown entity decoding", () => {
  it("decodes astral-plane numeric entities by code point, not fromCharCode", () => {
    // fromCharCode truncates mod 2^16, turning 😀 (U+1F600) into a wrong PUA
    // glyph (U+F600); a fetched page that writes the emoji as a numeric entity
    // must decode to the real emoji in the text returned to the model.
    expect(htmlToMarkdown("<p>grin &#128512;</p>").text).toBe("grin \u{1F600}");
    expect(htmlToMarkdown("<p>grin &#x1F600;</p>").text).toBe("grin \u{1F600}");
    expect(htmlToMarkdown("<p>grin &#128512;</p>").text).not.toContain("");
  });

  it("leaves BMP numeric entities intact", () => {
    expect(htmlToMarkdown("<p>&#65; &#9731;</p>").text).toBe("A ☃");
  });

  it("preserves an out-of-range numeric entity instead of throwing", () => {
    expect(() => htmlToMarkdown("<p>&#9999999;</p>")).not.toThrow();
    expect(htmlToMarkdown("<p>&#9999999;</p>").text).toBe("&#9999999;");
  });
});
