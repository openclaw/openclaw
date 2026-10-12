// Tool image tests cover image payload sanitization before tool outputs are
// returned to model-visible content blocks.

import { expectDefined } from "@openclaw/normalization-core";
import { RastermillUnavailableError } from "rastermill";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
  createTinyJpegBuffer,
} from "../../test/helpers/image-fixtures.js";
import { getImageMetadata } from "../media/image-ops.js";
import { resizeToJpeg } from "../media/media-services.js";
import {
  sanitizeContentBlocksImages,
  sanitizeImageBlocks,
  sanitizeToolResultImages,
} from "./tool-images.js";

vi.mock("../media/media-services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../media/media-services.js")>();
  return { ...actual, resizeToJpeg: vi.fn(actual.resizeToJpeg) };
});

describe("tool image sanitizing", () => {
  const getImageBlock = (
    blocks: Awaited<ReturnType<typeof sanitizeContentBlocksImages>>,
  ): (typeof blocks)[number] & { type: "image"; data: string; mimeType?: string } => {
    const image = blocks.find((block) => block.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    return image;
  };

  const createWidePng = async () => {
    return createSolidPngBuffer(420, 120, { r: 0x7f, g: 0x7f, b: 0x7f });
  };

  describe("persisted image outcome cache", () => {
    const resizeToJpegMock = vi.mocked(resizeToJpeg);
    const pngBlock = (png: Buffer) => ({
      type: "image" as const,
      data: png.toString("base64"),
      mimeType: "image/png",
    });
    const replay = (block: ReturnType<typeof pngBlock>, maxDimensionPx?: number) =>
      sanitizeContentBlocksImages([block], "session:history", {
        verifyDecodability: true,
        maxDimensionPx,
      });

    beforeEach(() => {
      resizeToJpegMock.mockClear();
    });

    it("verifies an in-limit replay once and resizes when the limits change", async () => {
      const block = pngBlock(createSolidPngBuffer(32, 24, { r: 17, g: 31, b: 47 }));

      expect(await replay(block)).toEqual([block]);
      expect(await replay(block)).toEqual([block]);
      expect(resizeToJpegMock).toHaveBeenCalledTimes(1);

      expect(getImageBlock(await replay(block, 16)).mimeType).toBe("image/jpeg");
      expect(resizeToJpegMock).toHaveBeenCalledTimes(2);
    });

    it("reuses the exact replacement for an oversized replay", async () => {
      const block = pngBlock(createSolidPngBuffer(2001, 8, { r: 53, g: 71, b: 89 }));

      const first = getImageBlock(await replay(block));
      expect(first.mimeType).toBe("image/jpeg");
      expect(resizeToJpegMock).toHaveBeenCalledTimes(1);
      resizeToJpegMock.mockClear();

      const second = getImageBlock(await replay(block));
      expect(second.mimeType).toBe("image/jpeg");
      expect(second.data).toBe(first.data);
      expect(resizeToJpegMock).not.toHaveBeenCalled();
    });

    it("retries verification after the image backend was unavailable", async () => {
      const block = pngBlock(createSolidPngBuffer(33, 25, { r: 97, g: 113, b: 131 }));
      resizeToJpegMock.mockRejectedValueOnce(
        new RastermillUnavailableError("encode", "backend missing"),
      );

      expect(await replay(block)).toEqual([block]);
      expect(await replay(block)).toEqual([block]);
      expect(resizeToJpegMock).toHaveBeenCalledTimes(2);
    });

    it("evicts older replacements when retained bytes exceed the budget", async () => {
      const blocks = Array.from({ length: 8 }, (_, index) =>
        pngBlock(createSolidPngBuffer(2001, 16 + index, { r: 149, g: 163, b: 181 })),
      );
      const replacement = Buffer.alloc(3 * 1024 * 1024);
      const replaced = (block: (typeof blocks)[number]) => [
        { ...block, data: replacement.toString("base64"), mimeType: "image/jpeg" },
      ];
      for (const block of blocks) {
        resizeToJpegMock.mockResolvedValueOnce(replacement);
        expect(await replay(block)).toEqual(replaced(block));
      }
      resizeToJpegMock.mockClear();

      // Check the newest entry before reinserting the evicted oldest entry.
      const last = expectDefined(blocks.at(-1), "last image");
      expect(await replay(last)).toEqual(replaced(last));
      expect(resizeToJpegMock).not.toHaveBeenCalled();
      const first = expectDefined(blocks[0], "first image");
      expect(getImageBlock(await replay(first)).mimeType).toBe("image/jpeg");
      expect(resizeToJpegMock).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    { name: "nonempty text", block: { type: "text", text: "hello" }, admitted: true },
    { name: "nonstring text", block: { type: "text", text: 42 }, admitted: false },
  ])("preserves text-only admission and identity for $name", async ({ block, admitted }) => {
    const content = [block] as Parameters<typeof sanitizeToolResultImages>[0]["content"];
    const details = { marker: "retained" };
    const result = { content, details };
    const original = structuredClone(result);

    const sanitized = await sanitizeToolResultImages(result, "test:text");

    expect(sanitized === result).toBe(!admitted);
    expect(sanitized.content === content).toBe(!admitted);
    expect(sanitized.content).toHaveLength(1);
    expect(sanitized.content[0]).toBe(block);
    expect(sanitized.details).toBe(details);
    expect(result).toEqual(original);
  });

  it("shrinks oversized images to the configured byte limit", async () => {
    const maxBytes = 64 * 1024;
    const width = 300;
    const height = 300;
    const bigPng = createNoisyPngBuffer(width, height);
    expect(bigPng.byteLength).toBeGreaterThan(maxBytes);

    const blocks = [
      {
        type: "image" as const,
        data: bigPng.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test", { maxBytes });
    const image = getImageBlock(out);
    const size = Buffer.from(image.data, "base64").byteLength;
    expect(size).toBeLessThanOrEqual(maxBytes);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("sanitizes image arrays and reports drops", async () => {
    const png = await createWidePng();

    const images = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test", {
      maxDimensionPx: 120,
    });
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await getImageMetadata(
      Buffer.from(expectDefined(out[0], "out[0] test invariant").data, "base64"),
    );
    expect(meta?.width).toBeLessThanOrEqual(120);
    expect(meta?.height).toBeLessThanOrEqual(120);
  }, 20_000);

  it("uses default image limits for non-finite options", async () => {
    const jpeg = createTinyJpegBuffer();

    const out = await sanitizeContentBlocksImages(
      [
        {
          type: "image" as const,
          data: jpeg.toString("base64"),
          mimeType: "image/png",
        },
      ],
      "test",
      { maxDimensionPx: Number.NaN, maxBytes: Number.NaN },
    );

    const image = getImageBlock(out);
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data).toBe(jpeg.toString("base64"));
  });

  it("screenshot-shaped tool result with malformed image produces text fallback", async () => {
    const result = {
      content: [
        {
          type: "image" as const,
          data: undefined as unknown as string,
          mimeType: undefined as unknown as string,
        },
      ],
      details: {},
    };
    const sanitized = await sanitizeToolResultImages(result, "browser:screenshot");
    const imageBlocks = sanitized.content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(0);
    const textFallback = sanitized.content.find(
      (b) => b.type === "text" && (b as { text: string }).text.includes("missing data or mimeType"),
    );
    expect(textFallback).toBeDefined();
  });

  it("drops malformed image base64 payloads", async () => {
    // Invalid base64 is replaced with text so malformed payloads cannot smuggle
    // attributes or script-like text through image blocks.
    const blocks = [
      {
        type: "image" as const,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toEqual([
      {
        type: "text",
        text: "[test] omitted image payload: invalid base64",
      },
    ]);
  });

  it("rejects oversized estimated input before decode allocation", async () => {
    const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
    const encodedLength = Math.ceil(((MAX_IMAGE_INPUT_BYTES + 1) * 4) / 3 / 4) * 4;
    const oversizedBase64 = "A".repeat(encodedLength);

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: oversizedBase64, mimeType: "image/png" }],
      "test",
    );

    expect(out).toStrictEqual([
      {
        type: "text",
        text: "[test] omitted image payload: image exceeds input size limit (10.00MB)",
      },
    ]);
  });
});
