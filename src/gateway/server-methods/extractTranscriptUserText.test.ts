import { describe, it, expect } from "vitest";
import { extractTranscriptUserText } from "./chat.js";

describe("extractTranscriptUserText", () => {
  it("returns string content unchanged", () => {
    expect(extractTranscriptUserText("Hello World")).toBe("Hello World");
  });

  it("removes media attachment markers from string", () => {
    const input = "Check this [media attached: media://inbound/abc123.png] image";
    expect(extractTranscriptUserText(input)).toBe("Check this  image");
  });

  it("handles array of text blocks by concatenating", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "World" },
    ];
    expect(extractTranscriptUserText(content)).toBe("HelloWorld");
  });

  it("strips media markers from array text blocks", () => {
    const content = [{ type: "text", text: "Start [media attached: media://inbound/xyz] end" }];
    expect(extractTranscriptUserText(content)).toBe("Start  end");
  });

  it("strips numbered media attachment markers", () => {
    expect(
      extractTranscriptUserText(
        "Check these [media attached 1/2: media://inbound/a.png] [media attached 2/2: media://inbound/b.png] images",
      ),
    ).toBe("Check these   images");
  });

  it("returns undefined for non-string non-array", () => {
    expect(extractTranscriptUserText(123)).toBeUndefined();
    expect(extractTranscriptUserText({})).toBeUndefined();
  });

  it("returns undefined for array without text blocks", () => {
    const content = [{ type: "image", url: "http://example.com/img.png" }];
    expect(extractTranscriptUserText(content)).toBeUndefined();
  });

  it("handles mixed blocks with some non-text", () => {
    const content = [
      { type: "text", text: "First" },
      { type: "image", url: "http://example.com/1.png" },
      { type: "text", text: "Second" },
    ];
    expect(extractTranscriptUserText(content)).toBe("FirstSecond");
  });
});
