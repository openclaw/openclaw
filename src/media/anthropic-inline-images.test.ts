import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { FILE_TYPE_SNIFF_MAX_BYTES } from "@openclaw/media-core/mime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAiTransportHost, runWithAiTransportHost } from "../../packages/ai/src/host.js";
import { buildAnthropicRequest } from "../../packages/ai/src/transports/anthropic-messages.js";
import { makeAnthropicTransportModel } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import type { Context } from "../../packages/llm-core/src/types.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";

vi.mock("@openclaw/media-core/base64", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/media-core/base64")>();
  return { ...actual, canonicalizeBase64: vi.fn(actual.canonicalizeBase64) };
});

const { convertImageToJpegMock, convertImageToPngMock, detectMimeMock } = vi.hoisted(() => ({
  convertImageToJpegMock: vi.fn(),
  convertImageToPngMock: vi.fn(),
  detectMimeMock: vi.fn(),
}));

vi.mock("@openclaw/media-core/mime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/media-core/mime")>()),
  detectMime: detectMimeMock,
}));

vi.mock("./image-ops.js", () => ({
  convertImageToJpeg: convertImageToJpegMock,
  convertImageToPng: convertImageToPngMock,
}));

import { normalizeAnthropicInlineContentBlocks } from "./anthropic-inline-images.js";

const image = (data: string, mimeType: string) => ({ type: "image" as const, data, mimeType });
const encodedImage = (bytes: string, mimeType: string) =>
  image(Buffer.from(bytes).toString("base64"), mimeType);
const normalizeImage = (data: string, mimeType: string) =>
  normalizeAnthropicInlineContentBlocks([image(data, mimeType)]);

describe("normalizeAnthropicInlineContentBlocks", () => {
  beforeEach(() => {
    convertImageToJpegMock.mockReset().mockResolvedValue(Buffer.from("converted-jpeg"));
    convertImageToPngMock.mockReset().mockResolvedValue(Buffer.from("converted-png"));
    detectMimeMock.mockReset();
  });

  it.each(["provider", "transport"] as const)(
    "canonicalizes frozen user and tool images once across %s requests",
    async (profile) => {
      detectMimeMock.mockResolvedValue("image/png");
      const canonicalize = vi.mocked(canonicalizeBase64).mockClear();
      const mutableImage = image("YQ", "image/png");
      const messages: Context["messages"] = [
        freezeJsonSnapshot({ role: "user", timestamp: 0, content: [image("Yg", "image/png")] }),
        freezeJsonSnapshot({
          role: "toolResult",
          timestamp: 1,
          toolCallId: "call_1",
          toolName: "read",
          isError: false,
          content: [image("Yw", "image/png")],
        }),
        { role: "user", timestamp: 2, content: [mutableImage] },
      ];
      const model = makeAnthropicTransportModel({ input: ["text", "image"] });
      const host = createAiTransportHost({ normalizeAnthropicInlineContentBlocks });
      const build = () =>
        runWithAiTransportHost(host, () =>
          buildAnthropicRequest(model, { messages }, undefined, profile, false, false),
        );
      const first = await build();
      expect(canonicalize).toHaveBeenCalledTimes(3);
      canonicalize.mockClear();
      expect((await build()).params).toEqual(first.params);
      expect(canonicalize).toHaveBeenCalledExactlyOnceWith("YQ");
      mutableImage.data = "ZA";
      canonicalize.mockClear();
      expect(JSON.stringify((await build()).params)).toContain('"data":"ZA=="');
      expect(canonicalize).toHaveBeenCalledExactlyOnceWith("ZA");
      detectMimeMock.mockResolvedValue(undefined);
      mutableImage.mimeType = "image/webp";
      expect(JSON.stringify((await build()).params)).toContain('"media_type":"image/webp"');
    },
  );

  it.each([32, FILE_TYPE_SNIFF_MAX_BYTES + 3])(
    "converts all %i unsupported bytes despite a supported declaration",
    async (size) => {
      detectMimeMock.mockResolvedValue("image/tiff");
      const original = Buffer.alloc(size, 0xa7);
      original.write("tiff-bytes", 0);
      original.write("complete-image-tail", size - 19);
      const tiffData = original.toString("base64");

      await expect(normalizeImage(tiffData, "image/jpeg")).resolves.toEqual([
        encodedImage("converted-jpeg", "image/jpeg"),
      ]);
      expect(convertImageToJpegMock).toHaveBeenCalledExactlyOnceWith(original);
    },
  );

  it("uses a supported declaration when byte detection is inconclusive", async () => {
    detectMimeMock.mockResolvedValue(undefined);
    const opaqueData = Buffer.from("not-a-recognized-image-header").toString("base64");

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: opaqueData, mimeType: "image/png" },
      ]),
    ).resolves.toEqual([{ type: "image", data: opaqueData, mimeType: "image/png" }]);
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("rejects oversized image data before MIME detection or decoding", async () => {
    const maxBytes = 10 * 1024 * 1024;
    const encodedLength = Math.ceil(((maxBytes + 1) * 4) / 3);

    await expect(
      normalizeAnthropicInlineContentBlocks([
        image("QQ==", "image/png"),
        image("A".repeat(encodedLength), "image/tiff"),
      ]),
    ).rejects.toThrow("10 MB decoded safety limit");
    expect(detectMimeMock).not.toHaveBeenCalled();
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it.each(["ZE==", "ZE", "-_8=", "Q!Q==", "QQ==QQ==", "QQ===", "S", "", " \n\t"])(
    "preserves permissive decoding and output data for %j",
    async (data) => {
      detectMimeMock.mockResolvedValue(undefined);
      await expect(
        normalizeAnthropicInlineContentBlocks([{ type: "image", data, mimeType: "image/png" }]),
      ).resolves.toEqual([{ type: "image", data: data.trim(), mimeType: "image/png" }]);
      expect(detectMimeMock).toHaveBeenCalledExactlyOnceWith({
        buffer: Buffer.from(data.trim(), "base64"),
      });
      expect(convertImageToJpegMock).not.toHaveBeenCalled();
      expect(convertImageToPngMock).not.toHaveBeenCalled();
    },
  );

  it("validates the complete input before choosing a MIME prefix", async () => {
    const original = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES * 2, 0xa7);
    const data = `${original.toString("base64")}!`;
    detectMimeMock.mockResolvedValue(undefined);

    await expect(normalizeImage(data, "image/png")).resolves.toEqual([image(data, "image/png")]);
    expect(detectMimeMock).toHaveBeenCalledExactlyOnceWith({ buffer: original });
  });

  it("routes detected BMP bytes through the fallback-capable PNG converter", async () => {
    detectMimeMock.mockResolvedValue("image/bmp");
    const bmpData = Buffer.from("bmp-bytes").toString("base64");

    await expect(normalizeImage(bmpData, "image/bmp")).resolves.toEqual([
      encodedImage("converted-png", "image/png"),
    ]);
    expect(convertImageToPngMock).toHaveBeenCalledOnce();
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("rejects converted images that exceed the outgoing size limit", async () => {
    detectMimeMock.mockResolvedValue("image/tiff");
    convertImageToJpegMock.mockResolvedValue(Buffer.alloc(10 * 1024 * 1024 + 1));

    await expect(
      normalizeAnthropicInlineContentBlocks([encodedImage("small-tiff", "image/tiff")]),
    ).rejects.toThrow("Normalized Anthropic inline image exceeds the 10 MB decoded safety limit");
  });
});
