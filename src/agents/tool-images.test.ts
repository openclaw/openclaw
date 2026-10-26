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
const solidImage = (width: number, height: number) =>
  imageBlock(createSolidPngBuffer(width, height, { r: 17, g: 31, b: 47 }));
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

    it.each([false, true])(
      "caches verified replay and retries unavailable backend=%s",
      async (unavailable) => {
        const block = solidImage(unavailable ? 33 : 32, 24);
        if (unavailable) {
          resizeToJpegMock.mockRejectedValueOnce(
            new RastermillUnavailableError("encode", "backend missing"),
          );
        }
        expect(await replay(block)).toEqual([block]);
        expect(await replay(block)).toEqual([block]);
        expect(resizeToJpegMock).toHaveBeenCalledTimes(unavailable ? 2 : 1);
        if (!unavailable) {
          expect(getImageBlock(await replay(block, 16)).mimeType).toBe("image/jpeg");
          expect(resizeToJpegMock).toHaveBeenCalledTimes(2);
        }
      },
    );

    it("evicts older replacements when retained bytes exceed the budget", async () => {
      const blocks = Array.from({ length: 8 }, (_, index) => solidImage(2001, 16 + index));
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
    expect(sanitized.content).toEqual([block]);
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
    const { images: out, dropped } = await sanitizeImageBlocks([solidImage(420, 120)], "test", {
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
    const limits = { maxDimensionPx: Number.NaN, maxBytes: Number.NaN };
    const image = getImageBlock(await sanitize(jpeg, limits));
    expect(image).toMatchObject({ mimeType: "image/jpeg", data: jpeg.toString("base64") });
  });

  it("screenshot-shaped tool result with malformed image produces text fallback", async () => {
    const missing = undefined as unknown as string;
    const sanitized = await sanitizeToolResultImages(
      { content: [{ type: "image", data: missing, mimeType: missing }], details: {} },
      "browser:screenshot",
    );
    expect(sanitized.content).toEqual([
      { type: "text", text: expect.stringContaining("missing data or mimeType") },
    ]);
  });

  it.each([
    ["invalid base64", (): string => 'AA==" onerror="alert(1)'],
    [
      "image exceeds input size limit (10.00MB)",
      (): string => "A".repeat(Math.ceil((10 * 1024 * 1024 + 1) / 3) * 4),
    ],
  ] as const)("rejects unsafe input: %s", async (reason, payload) => {
    expect(await sanitize(payload())).toStrictEqual(omitted(reason));
  });
});
