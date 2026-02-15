import { describe, expect, it } from "vitest";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";

describe("normalizeRpcAttachmentsToChatAttachments", () => {
  it("passes through string content", () => {
    const res = normalizeRpcAttachmentsToChatAttachments([
      { type: "file", mimeType: "image/png", fileName: "a.png", content: "Zm9v" },
    ]);
    expect(res).toEqual([
      { type: "file", mimeType: "image/png", fileName: "a.png", content: "Zm9v" },
    ]);
  });

  it("converts Uint8Array content to base64", () => {
    const bytes = new TextEncoder().encode("foo");
    const res = normalizeRpcAttachmentsToChatAttachments([{ content: bytes }]);
    expect(res[0]?.content).toBe("Zm9v");
  });
});
