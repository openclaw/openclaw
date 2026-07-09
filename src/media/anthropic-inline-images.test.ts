import { afterEach, describe, expect, it, vi } from "vitest";

const convertImageToJpegMock = vi.hoisted(() => vi.fn());

vi.mock("./image-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-ops.js")>();
  return {
    ...actual,
    convertImageToJpeg: (...args: unknown[]) => convertImageToJpegMock(...args),
  };
});

import { normalizeAnthropicInlineContentBlocks } from "./anthropic-inline-images.js";

const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

describe("normalizeAnthropicInlineContentBlocks", () => {
  afterEach(() => {
    convertImageToJpegMock.mockReset();
  });

  it("keeps already-supported mime types without re-encoding", async () => {
    const data = TINY_JPEG.toString("base64");
    const out = await normalizeAnthropicInlineContentBlocks([
      { type: "text", text: "caption" },
      { type: "image", data, mimeType: "image/png" },
    ]);

    expect(convertImageToJpegMock).not.toHaveBeenCalled();
    expect(out).toEqual([
      { type: "text", text: "caption" },
      { type: "image", data, mimeType: "image/png" },
    ]);
  });

  it("rewrites media_type from detected magic when declaration is unsupported", async () => {
    // JPEG bytes labeled HEIC: detectMime should accept without convertImageToJpeg.
    const data = TINY_JPEG.toString("base64");
    const out = await normalizeAnthropicInlineContentBlocks([
      { type: "image", data, mimeType: "image/heic" },
    ]);

    expect(convertImageToJpegMock).not.toHaveBeenCalled();
    expect(out).toEqual([{ type: "image", data, mimeType: "image/jpeg" }]);
  });

  it("transcodes unsupported bytes to jpeg when magic is not provider-supported", async () => {
    const source = Buffer.from("not-a-real-image-payload");
    const converted = Buffer.from("jpeg-bytes");
    convertImageToJpegMock.mockResolvedValueOnce(converted);

    const out = await normalizeAnthropicInlineContentBlocks([
      {
        type: "image",
        data: source.toString("base64"),
        mimeType: "image/tiff",
      },
    ]);

    expect(convertImageToJpegMock).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      {
        type: "image",
        data: converted.toString("base64"),
        mimeType: "image/jpeg",
      },
    ]);
  });
});
