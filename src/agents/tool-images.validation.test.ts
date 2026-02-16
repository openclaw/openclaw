import { describe, expect, it } from "vitest";
import { sanitizeContentBlocksImages } from "./tool-images.js";

describe("sanitizeContentBlocksImages base64 validation", () => {
  it("drops image blocks with invalid base64 data", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: "not!!valid==base64",
        mimeType: "image/jpeg",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect((out[0] as { text: string }).text).toContain("invalid base64");
  });

  it("drops image blocks with truncated base64 (length not multiple of 4)", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: "abc",
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect((out[0] as { text: string }).text).toContain("invalid base64");
  });

  it("strips data URL prefix before validation", async () => {
    // A valid 4x4 red JPEG in base64, wrapped in data URL prefix
    // We use a minimal valid base64 string that passes validation
    const validBase64 = "/9j/4AAQ"; // 8 chars, valid base64 (JPEG magic)
    const blocks = [
      {
        type: "image" as const,
        data: `data:image/jpeg;base64,${validBase64}`,
        mimeType: "image/jpeg",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    // The data URL prefix is stripped; the base64 content is processed
    // (it may fail during resize since it's not a real image, but it should
    // NOT fail on the "invalid base64" check)
    expect(out).toHaveLength(1);
    if (out[0].type === "text") {
      // If it becomes text, it's from the resize step, not from base64 validation
      expect((out[0] as { text: string }).text).not.toContain("invalid base64");
    }
  });

  it("replaces empty image blocks with descriptive text", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: "   ",
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect((out[0] as { text: string }).text).toContain("empty image payload");
  });

  it("passes through non-image blocks unchanged", async () => {
    const blocks = [
      {
        type: "text" as const,
        text: "Hello world",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ type: "text", text: "Hello world" });
  });
});
