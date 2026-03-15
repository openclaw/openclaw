import { describe, expect, it } from "vitest";
import { extractToolPayload } from "./tool-payload.js";

describe("extractToolPayload", () => {
  it("prefers explicit details payloads", () => {
    expect(
      extractToolPayload({
        details: { ok: true },
        content: [{ type: "text", text: '{"ignored":true}' }],
      } as never),
    ).toEqual({ ok: true });
  });

  it("parses JSON text blocks from tool content", () => {
    expect(
      extractToolPayload({
        content: [
          { type: "image", url: "https://example.com/a.png" },
          { type: "text", text: '{"ok":true,"count":2}' },
        ],
      } as never),
    ).toEqual({ ok: true, count: 2 });
  });

  it("falls back to raw text, then content, then the whole result", () => {
    expect(
      extractToolPayload({
        content: [{ type: "text", text: "not json" }],
      } as never),
    ).toBe("not json");

    const content = [{ type: "image", url: "https://example.com/a.png" }];
    expect(
      extractToolPayload({
        content,
      } as never),
    ).toBe(content);

    const result = { status: "ok" };
    expect(extractToolPayload(result as never)).toBe(result);
  });
});
