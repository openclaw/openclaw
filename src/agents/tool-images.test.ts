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

function imageBlock(data: Buffer | string, mimeType = "image/png") {
  return {
    type: "image" as const,
    data: typeof data === "string" ? data : data.toString("base64"),
    mimeType,
  };
}
function omitted(text: string) {
  return [{ type: "text", text: `[test] omitted image payload: ${text}` }];
}
describe("tool image sanitizing", () => {
  const getImageBlock = (blocks: Awaited<ReturnType<typeof sanitizeContentBlocksImages>>) =>
    expectDefined(
      blocks.find((block) => block.type === "image"),
      "expected image block",
    );
  const sanitize = (
    data: Buffer | string,
    options?: Parameters<typeof sanitizeContentBlocksImages>[2],
  ) => sanitizeContentBlocksImages([imageBlock(data)], "test", options);

  describe("persisted image outcome cache", () => {
    const resizeToJpegMock = vi.mocked(resizeToJpeg);
    const replay = (block: ReturnType<typeof imageBlock>, maxDimensionPx?: number) =>
      sanitizeContentBlocksImages([block], "session:history", {
        verifyDecodability: true,
        maxDimensionPx,
      });

    beforeEach(() => {
      resizeToJpegMock.mockClear();
    });

    it.each([
      { unavailable: false, width: 32, height: 24, color: { r: 17, g: 31, b: 47 }, calls: 1 },
      { unavailable: true, width: 33, height: 25, color: { r: 97, g: 113, b: 131 }, calls: 2 },
    ])(
      "caches verified replay and retries unavailable backend=$unavailable",
      async ({ unavailable, width, height, color, calls }) => {
        const block = imageBlock(createSolidPngBuffer(width, height, color));
        if (unavailable) {
          resizeToJpegMock.mockRejectedValueOnce(
            new RastermillUnavailableError("encode", "backend missing"),
          );
        }
        expect(await replay(block)).toEqual([block]);
        expect(await replay(block)).toEqual([block]);
        expect(resizeToJpegMock).toHaveBeenCalledTimes(calls);
        if (!unavailable) {
          expect(getImageBlock(await replay(block, 16)).mimeType).toBe("image/jpeg");
          expect(resizeToJpegMock).toHaveBeenCalledTimes(2);
        }
      },
    );

    it("evicts older replacements when retained bytes exceed the budget", async () => {
      const blocks = Array.from({ length: 8 }, (_, index) =>
        imageBlock(createSolidPngBuffer(2001, 16 + index, { r: 149, g: 163, b: 181 })),
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

    expect([sanitized === result, sanitized.content === content]).toEqual([!admitted, !admitted]);
    expect(sanitized.content).toHaveLength(1);
    expect(sanitized.content[0]).toBe(block);
    expect(sanitized.details).toBe(details);
    expect(result).toEqual(original);
  });

  it("shrinks oversized images to the configured byte limit", async () => {
    const maxBytes = 64 * 1024;
    const bigPng = createNoisyPngBuffer(300, 300);
    expect(bigPng.byteLength).toBeGreaterThan(maxBytes);

    const image = getImageBlock(await sanitize(bigPng, { maxBytes }));
    expect(Buffer.from(image.data, "base64").byteLength).toBeLessThanOrEqual(maxBytes);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("sanitizes image arrays and reports drops", async () => {
    const images = [imageBlock(createSolidPngBuffer(420, 120, { r: 0x7f, g: 0x7f, b: 0x7f }))];
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test", {
      maxDimensionPx: 120,
    });
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await getImageMetadata(Buffer.from(getImageBlock(out).data, "base64"));
    expect(meta?.width).toBeLessThanOrEqual(120);
    expect(meta?.height).toBeLessThanOrEqual(120);
  }, 20_000);

  it("uses default image limits for non-finite options", async () => {
    const jpeg = createTinyJpegBuffer();
    const image = getImageBlock(
      await sanitize(jpeg, {
        maxDimensionPx: Number.NaN,
        maxBytes: Number.NaN,
      }),
    );
    expect(image).toMatchObject({ mimeType: "image/jpeg", data: jpeg.toString("base64") });
  });

  it("screenshot-shaped tool result with malformed image produces text fallback", async () => {
    const missing = undefined as unknown as string;
    const result = {
      content: [{ type: "image" as const, data: missing, mimeType: missing }],
      details: {},
    };
    const sanitized = await sanitizeToolResultImages(result, "browser:screenshot");
    expect(sanitized.content).toEqual([
      { type: "text", text: expect.stringContaining("missing data or mimeType") },
    ]);
  });

  it("drops malformed image base64 payloads", async () => {
    // The image boundary must reject attribute smuggling.
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)';
    expect(await sanitize(payload)).toEqual(omitted("invalid base64"));
  });

  it("rejects oversized estimated input before decode allocation", async () => {
    const encodedLength = Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4;
    const oversizedBase64 = "A".repeat(encodedLength);

    expect(await sanitize(oversizedBase64)).toStrictEqual(
      omitted("image exceeds input size limit (10.00MB)"),
    );
  });
});
