import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import { MediaAttachmentCache } from "./attachments.js";
import type { ImageDescriptionRequest, MediaUnderstandingProvider } from "./types.js";

const { imagePolicy } = vi.hoisted(() => ({
  imagePolicy: vi.fn<() => Promise<ImageCompressionModelPolicy>>(),
}));

// mock-isolation: resize cases select a fixed compression policy without provider discovery.
vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: imagePolicy,
}));

const { runProviderEntry } = await import("./runner.entries.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ImageFixtureOptions = Partial<Pick<ImageDescriptionRequest, "fileName" | "mime" | "cfg">> & {
  maxBytes?: number;
  policy?: ImageCompressionModelPolicy;
};
async function setupProvider(source: Buffer, options: ImageFixtureOptions = {}) {
  imagePolicy
    .mockReset()
    .mockResolvedValue(options.policy ?? { maxSidePx: 1600, preferredSidePx: 1400 });
  const root = tempDirs.make("openclaw-image-resize-");
  const attachmentPath = path.join(root, options.fileName ?? "phone.png");
  await fs.writeFile(attachmentPath, source);
  const cache = new MediaAttachmentCache(
    [{ index: 0, path: attachmentPath, mime: options.mime ?? "image/png" }],
    { localPathRoots: [root], includeDefaultLocalPathRoots: false },
  );
  const description = { text: "described", model: "vision-v1" };
  const describeImage = vi.fn(async (_request: ImageDescriptionRequest) => description);
  const run = async () => {
    try {
      return await runProviderEntry({
        capability: "image",
        entry: { provider: "vision-plugin", model: "vision-v1", maxBytes: options.maxBytes },
        cfg: options.cfg ?? {},
        attachmentIndex: 0,
        cache,
        agentDir: root,
        providerRegistry: new Map<string, MediaUnderstandingProvider>([
          ["vision-plugin", { id: "vision-plugin", capabilities: ["image"], describeImage }],
        ]),
      });
    } finally {
      await cache.cleanup();
    }
  };
  return {
    async describe() {
      await expect(run()).resolves.toMatchObject({
        ok: true,
        value: { ...description, provider: "vision-plugin" },
      });
      expect(describeImage).toHaveBeenCalledOnce();
      return describeImage.mock.calls[0]![0];
    },
    async reject(maxBytes: number) {
      await expect(run()).rejects.toMatchObject({
        name: "MediaUnderstandingSkipError",
        reason: "maxBytes",
        message: `Attachment 1 exceeds maxBytes ${maxBytes}`,
      });
      expect(describeImage).not.toHaveBeenCalled();
    },
  };
}

const png = (width: number, height: number) =>
  createSolidPngBuffer(width, height, { r: 24, g: 96, b: 208 });

it.each(["high", "efficient", undefined] as const)(
  "respects model limits rather than the image-tool preference %s",
  async (quality) => {
    const source = quality ? png(1600, 1200) : png(2400, 1800);
    const provider = await setupProvider(source, {
      cfg: quality ? { agents: { defaults: { imageQuality: quality } } } : {},
      policy: quality ? undefined : {},
    });
    const request = await provider.describe();
    expect(readImageMetadataFromHeader(request.buffer)).toEqual(
      quality ? { width: 1400, height: 1050 } : { width: 2400, height: 1800 },
    );
    expect(request).toMatchObject({
      provider: "vision-plugin",
      model: "vision-v1",
      fileName: expect.stringMatching(/^phone\.(png|jpg)$/),
    });
    if (!quality) {
      expect(request.buffer.equals(source)).toBe(true);
      expect(request).toMatchObject({ mime: "image/png", fileName: "phone.png" });
    }
  },
);

it.each(["source", "PNG", "provider-owned"])(
  "enforces the %s byte cap before provider I/O",
  async (format) => {
    const custom = format === "provider-owned";
    const source = custom ? Buffer.from("custom-image") : png(1, 1);
    const maxBytes = format === "source" ? source.length - 1 : 8;
    const provider = await setupProvider(source, {
      ...(custom ? { fileName: "phone.custom", mime: "image/x-custom" } : {}),
      maxBytes: format === "source" ? maxBytes : undefined,
      policy: { maxBytes: 8 },
    });
    await provider.reject(maxBytes);
    expect(imagePolicy).toHaveBeenCalledTimes(format === "source" ? 0 : 1);
  },
);
