import * as base64 from "@openclaw/media-core/base64";
import { FILE_TYPE_SNIFF_MAX_BYTES } from "@openclaw/media-core/mime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAiTransportHost, runWithAiTransportHost } from "../../packages/ai/src/host.js";
import { buildAnthropicRequest } from "../../packages/ai/src/transports/anthropic-messages.js";
import { makeAnthropicTransportModel } from "../../packages/ai/src/transports/anthropic-transport-stream.test-support.js";
import type { Context } from "../../packages/llm-core/src/types.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";

const [jpeg, png, detect] = vi.hoisted(() => [vi.fn(), vi.fn(), vi.fn()] as const);

vi.mock("@openclaw/media-core/mime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/media-core/mime")>()),
  detectMime: detect,
}));
vi.mock("./image-ops.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-ops.js")>()),
  convertImageToJpeg: jpeg,
  convertImageToPng: png,
}));

import { normalizeAnthropicInlineContentBlocks } from "./anthropic-inline-images.js";

const image = (data: string, mimeType: string) => ({ type: "image" as const, data, mimeType });
const encodedImage = (bytes: string, mimeType: string) =>
  image(Buffer.from(bytes).toString("base64"), mimeType);
const normalizeImage = (data: string, mimeType: string) =>
  normalizeAnthropicInlineContentBlocks([image(data, mimeType)]);

describe("normalizeAnthropicInlineContentBlocks", () => {
  beforeEach(() => {
    jpeg.mockReset().mockResolvedValue(Buffer.from("converted-jpeg"));
    png.mockReset().mockResolvedValue(Buffer.from("converted-png"));
    detect.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(["provider", "transport"] as const)(
    "canonicalizes frozen user and tool images once across %s requests",
    async (profile) => {
      detect.mockResolvedValue("image/png");
      const canonicalize = vi.spyOn(base64, "canonicalizeBase64");
      const mutableImage = image("YQ", "image/png");
      const messages: Context["messages"] = [
        freezeJsonSnapshot({ role: "user", timestamp: 0, content: [image("Yg", "image/png")] }),
        freezeJsonSnapshot({
          ...makeTextToolResult("call_1", "read", "", false, 1),
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
      await build();
      await build();
      expect(canonicalize).toHaveBeenCalledTimes(4);
      mutableImage.data = "ZA";
      canonicalize.mockClear();
      expect(JSON.stringify((await build()).params)).toContain('"data":"ZA=="');
      expect(canonicalize).toHaveBeenCalledExactlyOnceWith("ZA");
    },
  );

  it.each([
    [32, "image/tiff", "image/jpeg", "converted-jpeg"],
    [FILE_TYPE_SNIFF_MAX_BYTES + 3, "image/tiff", "image/jpeg", "converted-jpeg"],
    [32, "image/bmp", "image/png", "converted-png"],
  ] as const)(
    "converts all %i %s bytes despite a supported declaration",
    async (size, detected, mime, converted) => {
      detect.mockResolvedValue(detected);
      const original = Buffer.alloc(size, 0xa7);
      original.write("source-bytes", 0);
      original.write("complete-image-tail", size - 19);
      await expect(normalizeImage(original.toString("base64"), "image/jpeg")).resolves.toEqual([
        encodedImage(converted, mime),
      ]);
      const converter = detected === "image/bmp" ? png : jpeg;
      expect(converter).toHaveBeenCalledExactlyOnceWith(original);
      expect(jpeg).toHaveBeenCalledTimes(mime === "image/jpeg" ? 1 : 0);
    },
  );

  it.each([false, true])("enforces the decoded cap (converted=%s)", async (converted) => {
    const bytes = 10 * 1024 * 1024 + 1;
    const content = [
      image("QQ==", "image/png"),
      image("A".repeat(converted ? 4 : Math.ceil((bytes * 4) / 3)), "image/tiff"),
    ];
    detect.mockResolvedValue("image/tiff");
    if (converted) {
      jpeg.mockResolvedValue(Buffer.alloc(bytes));
    }
    await expect(normalizeAnthropicInlineContentBlocks(content)).rejects.toThrow(
      `${converted ? "Normalized " : ""}Anthropic inline image exceeds the 10 MB decoded safety limit`,
    );
    expect(detect).toHaveBeenCalledTimes(converted ? 1 : 0);
    expect(jpeg).toHaveBeenCalledTimes(converted ? 1 : 0);
  });

  it.each(["ZE==", "ZE", "-_8=", "Q!Q==", "QQ==QQ==", "QQ===", "S", "", " \n\t", "b3BhcXVl"])(
    "preserves permissive decoding and output data for %j",
    async (data) => {
      detect.mockResolvedValue(undefined);
      await expect(normalizeImage(data, "image/png")).resolves.toEqual([
        image(data.trim(), "image/png"),
      ]);
      expect(detect).toHaveBeenCalledExactlyOnceWith({
        buffer: Buffer.from(data.trim(), "base64"),
      });
      expect(jpeg).not.toHaveBeenCalled();
      expect(png).not.toHaveBeenCalled();
    },
  );

  it("validates the complete input before choosing a MIME prefix", async () => {
    const original = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES * 2, 0xa7);
    const data = `${original.toString("base64")}!`;
    detect.mockResolvedValue(undefined);

    await expect(normalizeImage(data, "image/png")).resolves.toEqual([image(data, "image/png")]);
    expect(detect).toHaveBeenCalledExactlyOnceWith({ buffer: original });
  });
});
