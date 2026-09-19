import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import { MediaAttachmentCache } from "./attachments.js";
import type { ImageDescriptionRequest, MediaUnderstandingProvider } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveImageCompressionModelPolicy: vi.fn<() => Promise<ImageCompressionModelPolicy>>(),
}));

vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: mocks.resolveImageCompressionModelPolicy,
}));

const { runProviderEntry } = await import("./runner.entries.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function setupProvider(
  source: Buffer,
  options: {
    fileName?: string;
    mime?: string;
    cfg?: OpenClawConfig;
    maxBytes?: number;
    inspect?: (request: ImageDescriptionRequest) => void;
  } = {},
) {
  const root = tempDirs.make("openclaw-image-resize-");
  const attachmentPath = path.join(root, options.fileName ?? "phone.png");
  await fs.writeFile(attachmentPath, source);
  const cache = new MediaAttachmentCache(
    [{ index: 0, path: attachmentPath, mime: options.mime ?? "image/png" }],
    { localPathRoots: [root], includeDefaultLocalPathRoots: false },
  );
  const describeImage = vi.fn(async (request: ImageDescriptionRequest) => {
    options.inspect?.(request);
    return { text: "described", model: "vision-v1" };
  });
  const cfg: OpenClawConfig = options.cfg ?? {};
  const ctx: MsgContext = { Body: "Describe this image.", MediaPath: attachmentPath };
  return {
    describeImage,
    run: async () => {
      try {
        return await runProviderEntry({
          capability: "image",
          entry: { provider: "vision-plugin", model: "vision-v1", maxBytes: options.maxBytes },
          cfg,
          ctx,
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
    },
  };
}

describe("runProviderEntry image resize boundary", () => {
  beforeEach(() => {
    mocks.resolveImageCompressionModelPolicy.mockReset().mockResolvedValue({
      maxSidePx: 1600,
      preferredSidePx: 1400,
    });
  });

  it.each(["high", "efficient"] as const)(
    "does not apply the image-tool-only %s preference to a custom provider",
    async (quality) => {
      const source = createSolidPngBuffer(1600, 1200, { r: 24, g: 96, b: 208 });
      const { run, describeImage } = await setupProvider(source, {
        cfg: { agents: { defaults: { imageQuality: quality } } },
        inspect: (request) => {
          expect(readImageMetadataFromHeader(request.buffer)).toEqual({
            width: 1400,
            height: 1050,
          });
          expect(request).toMatchObject({ provider: "vision-plugin", model: "vision-v1" });
          expect(request.fileName).toMatch(/^phone\.(png|jpg)$/);
        },
      });
      await expect(run()).resolves.toMatchObject({
        ok: true,
        value: { text: "described", provider: "vision-plugin" },
      });
      expect(describeImage).toHaveBeenCalledOnce();
    },
  );

  it("preserves recognized images at the provider boundary when the model declares no limits", async () => {
    const source = createSolidPngBuffer(2400, 1800, { r: 24, g: 96, b: 208 });
    mocks.resolveImageCompressionModelPolicy.mockResolvedValue({});
    const { run, describeImage } = await setupProvider(source, {
      inspect: (request) => {
        expect(request.buffer.equals(source)).toBe(true);
        expect(readImageMetadataFromHeader(request.buffer)).toEqual({ width: 2400, height: 1800 });
        expect(request).toMatchObject({ mime: "image/png", fileName: "phone.png" });
      },
    });
    await expect(run()).resolves.toMatchObject({ ok: true, value: { text: "described" } });
    expect(describeImage).toHaveBeenCalledOnce();
  });

  it("enforces the configured source cap before optimizer and provider work", async () => {
    const source = createSolidPngBuffer(1600, 1200, { r: 24, g: 96, b: 208 });
    const maxBytes = source.length - 1;
    const { run, describeImage } = await setupProvider(source, { maxBytes });
    await expect(run()).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: `Attachment 1 exceeds maxBytes ${maxBytes}`,
    });
    expect(mocks.resolveImageCompressionModelPolicy).not.toHaveBeenCalled();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("reports the model byte cap when a valid image cannot be encoded small enough", async () => {
    const source = createSolidPngBuffer(1, 1, { r: 24, g: 96, b: 208 });
    mocks.resolveImageCompressionModelPolicy.mockResolvedValue({ maxBytes: 8 });
    const { run, describeImage } = await setupProvider(source);
    await expect(run()).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 8",
    });
    expect(mocks.resolveImageCompressionModelPolicy).toHaveBeenCalledOnce();
    expect(describeImage).not.toHaveBeenCalled();
  });

  it("enforces the selected model byte cap for provider-owned image formats", async () => {
    mocks.resolveImageCompressionModelPolicy.mockResolvedValue({ maxBytes: 8 });
    const { run, describeImage } = await setupProvider(Buffer.from("custom-image"), {
      fileName: "phone.custom",
      mime: "image/x-custom",
    });
    await expect(run()).rejects.toMatchObject({
      name: "MediaUnderstandingSkipError",
      reason: "maxBytes",
      message: "Attachment 1 exceeds maxBytes 8",
    });
    expect(describeImage).not.toHaveBeenCalled();
  });
});
