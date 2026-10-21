import { expect, onTestFinished, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as defaults from "../../media-understanding/defaults.js";
import * as descriptions from "../../media-understanding/image-runtime.js";
import * as registry from "../../media-understanding/provider-registry.js";
import * as media from "../../media/web-media.js";
import type { MediaUnderstandingProvider } from "../../plugin-sdk/media-understanding.js";
import * as capabilities from "../../plugins/capability-provider-runtime.js";
import * as models from "../embedded-agent-runner/model.js";
import {
  coerceImageAssistantText,
  decodeDataUrl,
  hasImageReasoningOnlyResponse,
} from "./image-tool.helpers.js";
import { createImageTool } from "./image-tool.js";
import * as execution from "./image-tool.model-execution.js";

export type ToolTextResult = {
  content?: Array<{
    type?: string;
    text?: string;
    image_url?: { url?: string };
  }>;
  details?: Record<string, unknown>;
};

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
  const result = await createRequiredImageTool(options).execute("implicit-image", {
    prompt: "Inspect this image.",
    path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
  });
  expectToolText(result, "inspected");
  return { result, requests };
}

type ImageWebMediaRuntime = {
  loadWebMedia(
    mediaUrl: string,
    options?: Exclude<Parameters<typeof media.loadWebMedia>[1], number | undefined>,
  ): ReturnType<typeof media.loadWebMedia>;
  optimizeImageBufferForWebMedia: typeof media.optimizeImageBufferForWebMedia;
};

export function createImageWebMediaRuntime(
  loadWebMedia: ImageWebMediaRuntime["loadWebMedia"] = async () => {
    throw new Error("expected inline image");
  },
): ImageWebMediaRuntime {
  return {
    loadWebMedia,
    optimizeImageBufferForWebMedia: vi.fn(async ({ buffer, contentType, fileName }) => ({
      buffer,
      contentType: contentType ?? "image/png",
      kind: "image" as const,
      fileName,
    })),
  };
}

type ImageToolProviderDeps = {
  buildProviderRegistry: typeof registry.buildMediaUnderstandingRegistry;
  getMediaUnderstandingProvider: typeof registry.getMediaUnderstandingProvider;
  describeImageWithModel: typeof descriptions.describeImageWithModel;
  describeImagesWithModel: typeof descriptions.describeImagesWithModel;
  resolveAutoMediaKeyProviders: typeof defaults.resolveAutoMediaKeyProviders;
  resolveDefaultMediaModel: typeof defaults.resolveDefaultMediaModel;
  resolveModelAsync: typeof models.resolveModelAsync;
  resolveRegisteredMediaUnderstandingProvider(params: {
    providerId: string;
    cfg?: OpenClawConfig;
  }): MediaUnderstandingProvider | undefined;
  resolveImageCompressionPolicy: typeof execution.prepareImageCompressionPolicy;
  loadImageWebMediaRuntime: () => Promise<ImageWebMediaRuntime>;
};

const restoreSpies: Array<() => void> = [];

function mockDependency<T>(
  value: T | undefined,
  create: () => { mockImplementation(value: T): { mockRestore(): void } },
) {
  if (value) {
    const spy = create().mockImplementation(value);
    restoreSpies.push(() => spy.mockRestore());
  }
}

function setProviderDepsForTest(overrides?: Partial<ImageToolProviderDeps>): void {
  for (const restore of restoreSpies.splice(0)) {
    restore();
  }
  if (!overrides) {
    return;
  }
  mockDependency(overrides.buildProviderRegistry, () =>
    vi.spyOn(registry, "buildMediaUnderstandingRegistry"),
  );
  mockDependency(overrides.getMediaUnderstandingProvider, () =>
    vi.spyOn(registry, "getMediaUnderstandingProvider"),
  );
  mockDependency(overrides.describeImageWithModel, () =>
    vi.spyOn(descriptions, "describeImageWithModel"),
  );
  mockDependency(overrides.describeImagesWithModel, () =>
    vi.spyOn(descriptions, "describeImagesWithModel"),
  );
  mockDependency(overrides.resolveAutoMediaKeyProviders, () =>
    vi.spyOn(defaults, "resolveAutoMediaKeyProviders"),
  );
  mockDependency(overrides.resolveDefaultMediaModel, () =>
    vi.spyOn(defaults, "resolveDefaultMediaModel"),
  );
  mockDependency(overrides.resolveModelAsync, () => vi.spyOn(models, "resolveModelAsync"));
  mockDependency(overrides.resolveImageCompressionPolicy, () =>
    vi.spyOn(execution, "prepareImageCompressionPolicy"),
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
    restoreSpies.push(() => spy.mockRestore());
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
    restoreSpies.push(
      () => loadSpy.mockRestore(),
      () => optimizeSpy.mockRestore(),
    );
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

export function createMinimaxImageConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "minimax/MiniMax-M2.7" },
        imageModel: { primary: "minimax/MiniMax-VL-01" },
      },
    },
    plugins: { entries: { minimax: { enabled: true } } },
  };
}

export const resolveConfiguredImageModelForTest: typeof models.resolveModelAsync = async (
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
