import { describe, expect, it } from "vitest";
import { resolveInlineAgentImageAttachments } from "./agent-turn-attachments.js";

// A 1x1 transparent PNG, valid ASCII base64 (represents a correctly-encoded image).
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const isAsciiOnly = (value: string): boolean => {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) {
      return false;
    }
  }
  return true;
};

describe("resolveInlineAgentImageAttachments base64 safety", () => {
  it("re-encodes raw latin1/binary data into ASCII base64", () => {
    // Simulate a channel plugin handing in a replayed/history image whose `data`
    // is a raw latin1 byte string (the bug: it was forwarded untouched into
    // `source.base64`, which Anthropic rejects for non-ASCII content).
    const rawBytes = Buffer.from(VALID_PNG_BASE64, "base64");
    const latin1Data = rawBytes.toString("latin1");
    expect(isAsciiOnly(latin1Data)).toBe(false);

    const [attachment] = resolveInlineAgentImageAttachments([
      { data: latin1Data, mimeType: "image/png" },
    ]);

    expect(attachment).toBeDefined();
    // The resulting source.base64 must be pure ASCII.
    expect(isAsciiOnly(attachment.data)).toBe(true);
    // And it must decode back to the original image bytes (no corruption).
    expect(Buffer.from(attachment.data, "base64").equals(rawBytes)).toBe(true);
  });

  it("passes already-valid base64 through unchanged (idempotent)", () => {
    const [attachment] = resolveInlineAgentImageAttachments([
      { data: VALID_PNG_BASE64, mimeType: "image/jpeg" },
    ]);

    expect(attachment).toBeDefined();
    expect(attachment.data).toBe(VALID_PNG_BASE64);
    expect(attachment.mediaType).toBe("image/jpeg");
  });

  it("filters out non-image and empty attachments (behavior unchanged)", () => {
    const result = resolveInlineAgentImageAttachments([
      { data: VALID_PNG_BASE64, mimeType: "text/plain" },
      { data: "   ", mimeType: "image/png" },
      { data: VALID_PNG_BASE64, mimeType: "image/png" },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].mediaType).toBe("image/png");
  });

  it("returns an empty array when images is undefined", () => {
    expect(resolveInlineAgentImageAttachments(undefined)).toEqual([]);
  });
});
