// Tool-result text extraction keeps provider conversion lossless; established
// context/tool-result guards own payload budgeting and truncation later.
import { describe, expect, it } from "vitest";
import { extractToolResultText } from "./tool-result-text.js";

describe("extractToolResultText", () => {
  it("redacts structured secret fields with the shared tool-payload contract", () => {
    const text = extractToolResultText([
      {
        type: "json",
        credential: "live-credential-value",
        appSecret: "app-secret-value",
        rawSecret: "raw-secret-value",
        nested: {
          token: "nested-token-value",
          visible: "safe-value",
        },
      },
    ]);

    expect(text).toContain('"credential":"');
    expect(text).toContain('"appSecret":"');
    expect(text).toContain('"rawSecret":"');
    expect(text).toContain('"token":"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).not.toContain("live-credential-value");
    expect(text).not.toContain("app-secret-value");
    expect(text).not.toContain("raw-secret-value");
    expect(text).not.toContain("nested-token-value");
  });

  it("keeps media-only blocks out of provider replay text", () => {
    const text = extractToolResultText([
      { type: "text", text: "summary" },
      { type: "image", data: "image-binary", mimeType: "image/png" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc123" } },
      { type: "input_image", image_url: "data:image/png;base64,def456" },
      { type: "audio", data: "audio-binary", mimeType: "audio/mpeg" },
    ]);

    expect(text).toBe("summary");
    expect(text).not.toContain("image-binary");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain("def456");
    expect(text).not.toContain("audio-binary");
  });

  it("omits MIME-tagged binary data while preserving textual resource data", () => {
    const text = extractToolResultText([
      { type: "resource", mime_type: "application/octet-stream", data: "AAECAwQFBgc=" },
      { type: "resource", mediaType: "application/json", data: '{"ok":true}' },
    ]);

    expect(text).toContain('"data":"[binary data omitted: 12 chars]"');
    expect(text).toContain('{\\"ok\\":true}');
    expect(text).not.toContain("AAECAwQFBgc=");
  });

  it("redacts inline data URIs without touching ordinary data-colon prose", () => {
    const text = extractToolResultText([
      {
        type: "json",
        value: {
          note: "metadata:ready",
          prose: "data: is ordinary prose",
          preview: "thumbnail=data:image/png;base64,abcdef done",
        },
      },
    ]);

    expect(text).toContain("metadata:ready");
    expect(text).toContain("data: is ordinary prose");
    expect(text).toContain("[inline data URI:");
    expect(text).not.toContain("abcdef");
  });

  it("omits opaque or binary structured fields", () => {
    const text = extractToolResultText([
      {
        type: "json",
        encrypted_content: "ciphertext",
        bytes: [1, 2, 3],
        visible: "safe-value",
      },
    ]);

    expect(text).toContain('"encrypted_content":"[omitted encrypted_content]"');
    expect(text).toContain('"bytes":"[omitted bytes]"');
    expect(text).toContain('"visible":"safe-value"');
    expect(text).not.toContain("ciphertext");
  });

  it("does not truncate structured blocks at the provider helper boundary", () => {
    const tail = "tail-marker";
    const text = extractToolResultText([
      {
        type: "json",
        data: {
          payload: `${"x".repeat(1_200)}${tail}`,
        },
      },
    ]);

    expect(text.length).toBeGreaterThan(1_200);
    expect(text).toContain(tail);
    expect(text).not.toContain("... (");
  });
});
