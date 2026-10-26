import { expectDefined } from "@openclaw/normalization-core";
import { expect, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as defaults from "../../media-understanding/defaults.js";
import * as descriptions from "../../media-understanding/image-runtime.js";
import * as registry from "../../media-understanding/provider-registry.js";
import { encodePngRgba, fillPixel } from "../../media/png-encode.js";
import * as media from "../../media/web-media.js";
import type { WebMediaResult } from "../../media/web-media.js";
import type {
  ImageDescriptionRequest,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import * as capabilities from "../../plugins/capability-provider-runtime.js";
import * as models from "../embedded-agent-runner/model.js";
import {
  coerceImageAssistantText,
  decodeDataUrl,
  hasImageReasoningOnlyResponse,
} from "./image-tool.helpers.js";
import { createImageTool } from "./image-tool.js";
import * as execution from "./image-tool.model-execution.js";

export type ToolTextResult = Awaited<
  ReturnType<NonNullable<ReturnType<typeof createImageTool>>["execute"]>
>;

export function expectToolText(result: unknown, text: string): void {
  const content = (result as ToolTextResult).content ?? [];
  expect(content.some((block) => block.type === "text" && block.text === text)).toBe(true);
}

export function createRequiredImageTool(args: Parameters<typeof createImageTool>[0]) {
  const tool = createImageTool(args);
  if (!tool) {
    throw new Error("expected image tool");
  }
  return tool;
}

export async function executeImplicitImageTool(
  options: Parameters<typeof createImageTool>[0],
  failures = 0,
) {
  const requests: string[] = [];
  const describe = vi
    .spyOn(descriptions, "describeImageWithModel")
    .mockImplementation(async (request) => {
      requests.push(`${request.provider}/${request.model}`);
      if (requests.length <= failures) {
        throw new Error("fixture image model unavailable");
      }
      return { text: "inspected", model: request.model };
    });
  const provider = vi.spyOn(registry, "getMediaUnderstandingProvider").mockReturnValue(undefined);
  // Routing keeps image bytes real; independent compression cases own metadata.
  const compression = vi
    .spyOn(execution, "prepareImageCompressionPolicy")
    .mockImplementation(async ({ imageCount }) => ({ imageCount }));
  onTestFinished(() => {
    compression.mockRestore();
    provider.mockRestore();
    describe.mockRestore();
  });
  const tool = createRequiredImageTool(options);
  const result = await tool.execute("implicit-image", {
    prompt: "Inspect this image.",
    path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
  });
  expectToolText(result, "inspected");
  return { result, requests };
}

type ResolveModelAsync = (typeof import("../embedded-agent-runner/model.js"))["resolveModelAsync"];

type ImageToolLoadWebMediaOptions = Exclude<
  Parameters<typeof media.loadWebMedia>[1],
  number | undefined
>;

type ImageWebMediaRuntime = {
  loadWebMedia(mediaUrl: string, options?: ImageToolLoadWebMediaOptions): Promise<WebMediaResult>;
  optimizeImageBufferForWebMedia: typeof media.optimizeImageBufferForWebMedia;
};

type ImageToolProviderDeps = {
  buildProviderRegistry: typeof registry.buildMediaUnderstandingRegistry;
  getMediaUnderstandingProvider: typeof registry.getMediaUnderstandingProvider;
  describeImageWithModel: typeof descriptions.describeImageWithModel;
  describeImagesWithModel: typeof descriptions.describeImagesWithModel;
  resolveAutoMediaKeyProviders: typeof defaults.resolveAutoMediaKeyProviders;
  resolveDefaultMediaModel: typeof defaults.resolveDefaultMediaModel;
  resolveModelAsync: ResolveModelAsync;
  resolveRegisteredMediaUnderstandingProvider(params: {
    providerId: string;
    cfg?: OpenClawConfig;
  }): MediaUnderstandingProvider | undefined;
  resolveImageCompressionPolicy: typeof execution.prepareImageCompressionPolicy;
  loadImageWebMediaRuntime: () => Promise<ImageWebMediaRuntime>;
};

const restoreSpies: Array<{ mockRestore(): void }> = [];

function installOverride<T>(
  override: T | undefined,
  install: (implementation: T) => { mockRestore(): void },
) {
  if (override) {
    restoreSpies.push(install(override));
  }
}

function setProviderDepsForTest(overrides?: Partial<ImageToolProviderDeps>): void {
  for (const restore of restoreSpies.splice(0)) {
    restore.mockRestore();
  }
  if (!overrides) {
    return;
  }
  installOverride(overrides.buildProviderRegistry, (impl) =>
    vi.spyOn(registry, "buildMediaUnderstandingRegistry").mockImplementation(impl),
  );
  installOverride(overrides.getMediaUnderstandingProvider, (impl) =>
    vi.spyOn(registry, "getMediaUnderstandingProvider").mockImplementation(impl),
  );
  installOverride(overrides.describeImageWithModel, (impl) =>
    vi.spyOn(descriptions, "describeImageWithModel").mockImplementation(impl),
  );
  installOverride(overrides.describeImagesWithModel, (impl) =>
    vi.spyOn(descriptions, "describeImagesWithModel").mockImplementation(impl),
  );
  installOverride(overrides.resolveAutoMediaKeyProviders, (impl) =>
    vi.spyOn(defaults, "resolveAutoMediaKeyProviders").mockImplementation(impl),
  );
  installOverride(overrides.resolveDefaultMediaModel, (impl) =>
    vi.spyOn(defaults, "resolveDefaultMediaModel").mockImplementation(impl),
  );
  installOverride(overrides.resolveModelAsync, (impl) =>
    vi.spyOn(models, "resolveModelAsync").mockImplementation(impl),
  );
  installOverride(overrides.resolveImageCompressionPolicy, (impl) =>
    vi.spyOn(execution, "prepareImageCompressionPolicy").mockImplementation(impl),
  );
  if (overrides.resolveRegisteredMediaUnderstandingProvider) {
    const resolve = overrides.resolveRegisteredMediaUnderstandingProvider;
    const original = capabilities.resolvePluginCapabilityProvider;
    const spy = vi
      .spyOn(capabilities, "resolvePluginCapabilityProvider")
      .mockImplementation((params) =>
        params.key === "mediaUnderstandingProviders"
          ? (resolve(params) as never)
          : original(params),
      );
    restoreSpies.push(spy);
  }
  if (overrides.loadImageWebMediaRuntime) {
    const load = overrides.loadImageWebMediaRuntime;
    const loadSpy = vi.spyOn(media, "loadWebMedia").mockImplementation(async (url, options) => {
      if (typeof options === "number") {
        throw new Error("Image fixture expects structured media options");
      }
      return (await load()).loadWebMedia(url, options);
    });
    const optimizeSpy = vi
      .spyOn(media, "optimizeImageBufferForWebMedia")
      .mockImplementation(async (...args) =>
        (await load()).optimizeImageBufferForWebMedia(...args),
      );
    restoreSpies.push(loadSpy, optimizeSpy);
  }
}

export const testing = {
  decodeDataUrl,
  coerceImageAssistantText,
  hasImageReasoningOnlyResponse,
  resolveImageCompressionPolicy: (
    params: Parameters<typeof execution.prepareImageCompressionPolicy>[0],
  ) => execution.prepareImageCompressionPolicy(params),
  setProviderDepsForTest,
};
export const ONE_PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAHdElNRQfqBBsGAQr00ED3AAAAJXRFWHRkYXRlOmNyZWF0ZQAyMDI2LTA0LTI3VDA2OjAxOjEwKzAwOjAwPU3tXwAAACV0RVh0ZGF0ZTptb2RpZnkAMjAyNi0wNC0yN1QwNjowMToxMCswMDowMEwQVeMAAAAodEVYdGRhdGU6dGltZXN0YW1wADIwMjYtMDQtMjdUMDY6MDE6MTArMDA6MDAbBXQ8AAAAeElEQVRo3u3awQnDQBAEwT2Q8w/YAikIP5rF1RFMca+FO8/s7rrnqjcA1BsA6g0A9QaAesOfA77zqTf8Blj/AgAAAAAAAJsDqAOoA6gDqAOoc9TXAdQB1AHUAdQB1AHUAdQB1AHU7Qc46gEAAAAANrcecGZ2f8B/ASYSQPlKoEJ/AAAAAElFTkSuQmCC";

export function createLargeColorBlockPng(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4, 255);
  const centerStart = Math.floor(size * 0.25);
  const centerEnd = Math.floor(size * 0.75);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inCenter = x >= centerStart && x < centerEnd && y >= centerStart && y < centerEnd;
      fillPixel(buf, x, y, size, inCenter ? 230 : 30, inCenter ? 40 : 110, inCenter ? 35 : 220);
    }
  }
  return encodePngRgba(buf, size, size);
}

export function readJpegDimensions(buffer: Buffer): { width: number; height: number } {
  // The tests inspect JPEG SOF markers directly so resize assertions do not
  // depend on an external decoder.
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = expectDefined(buffer[offset + 1], "buffer[offset + 1] test invariant");
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue;
    }
    const segmentLength = buffer.readUInt16BE(offset);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return {
        height: buffer.readUInt16BE(offset + 3),
        width: buffer.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  throw new Error("JPEG dimensions not found");
}

export function createMinimaxImageConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "minimax/MiniMax-M2.7" },
        imageModel: { primary: "minimax/MiniMax-VL-01" },
      },
    },
    plugins: {
      entries: {
        minimax: { enabled: true },
      },
    },
  };
}

export const resolveConfiguredImageModelForTest: ResolveModelAsync = async (
  provider,
  model,
  _agentDir,
  cfg,
) => {
  const configuredModel = cfg?.models?.providers?.[provider]?.models?.find(
    (candidate) => candidate.id === model || candidate.id === `${provider}/${model}`,
  );
  return {
    logicalRef: { provider, model },
    model: {
      ...configuredModel,
      id: model,
      provider,
      input: configuredModel?.input ?? ["text", "image"],
    } as never,
    authStorage: {} as never,
    modelRegistry: {} as never,
  };
};

export async function replyImageOk(params: ImageDescriptionRequest) {
  return { text: "ok", model: params.model };
}
