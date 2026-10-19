import { vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as defaults from "../../media-understanding/defaults.js";
import type {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import * as descriptions from "../../media-understanding/image-runtime.js";
import * as registry from "../../media-understanding/provider-registry.js";
import type {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import * as media from "../../media/web-media.js";
import type { ImageCompressionPolicy, WebMediaResult } from "../../media/web-media.js";
import type {
  describeImageWithModel,
  describeImagesWithModel,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import * as capabilities from "../../plugins/capability-provider-runtime.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import * as models from "../embedded-agent-runner/model.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import {
  coerceImageAssistantText,
  decodeDataUrl,
  hasImageReasoningOnlyResponse,
  type ImageModelConfig,
} from "./image-tool.helpers.js";
import * as execution from "./image-tool.model-execution.js";
import "./image-tool.js";

type ResolveModelAsync = (typeof import("../embedded-agent-runner/model.js"))["resolveModelAsync"];

type ImageToolLoadWebMediaOptions = Exclude<
  Parameters<typeof media.loadWebMedia>[1],
  number | undefined
>;

type ImageWebMediaRuntime = {
  loadWebMedia(mediaUrl: string, options?: ImageToolLoadWebMediaOptions): Promise<WebMediaResult>;
  optimizeImageBufferForWebMedia: typeof media.optimizeImageBufferForWebMedia;
};

type ResolveImageCompressionPolicy = (params: {
  abortSignal?: AbortSignal;
  cfg?: OpenClawConfig;
  imageModelConfig?: ImageModelConfig | null;
  modelOverride?: string;
  imageCount: number;
  agentDir?: string;
  workspaceDir?: string;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}) => Promise<ImageCompressionPolicy>;

type ImageToolProviderDeps = {
  buildProviderRegistry: typeof buildMediaUnderstandingRegistry;
  getMediaUnderstandingProvider: typeof getMediaUnderstandingProvider;
  describeImageWithModel: typeof describeImageWithModel;
  describeImagesWithModel: typeof describeImagesWithModel;
  resolveAutoMediaKeyProviders: typeof resolveAutoMediaKeyProviders;
  resolveDefaultMediaModel: typeof resolveDefaultMediaModel;
  resolveModelAsync: ResolveModelAsync;
  resolveRegisteredMediaUnderstandingProvider(params: {
    providerId: string;
    cfg?: OpenClawConfig;
  }): MediaUnderstandingProvider | undefined;
  resolveImageCompressionPolicy: ResolveImageCompressionPolicy;
  loadImageWebMediaRuntime: () => Promise<ImageWebMediaRuntime>;
};

type ImageToolTestApi = {
  resolveImageModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir: string;
    workspaceDir?: string;
    authStore?: AuthProfileStore;
    preparedModelRuntime?: PreparedModelRuntimeSnapshot;
  }): ImageModelConfig | null;
};

function getTestApi(): ImageToolTestApi {
  const api = (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.imageToolTestApi")];
  if (!api) {
    throw new Error("image tool test API is unavailable");
  }
  return api as ImageToolTestApi;
}

const restoreSpies: Array<() => void> = [];

function setProviderDepsForTest(overrides?: Partial<ImageToolProviderDeps>): void {
  for (const restore of restoreSpies.splice(0)) {
    restore();
  }
  if (!overrides) {
    return;
  }
  if (overrides.buildProviderRegistry) {
    const spy = vi
      .spyOn(registry, "buildMediaUnderstandingRegistry")
      .mockImplementation(overrides.buildProviderRegistry);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.getMediaUnderstandingProvider) {
    const spy = vi
      .spyOn(registry, "getMediaUnderstandingProvider")
      .mockImplementation(overrides.getMediaUnderstandingProvider);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.describeImageWithModel) {
    const spy = vi
      .spyOn(descriptions, "describeImageWithModel")
      .mockImplementation(overrides.describeImageWithModel);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.describeImagesWithModel) {
    const spy = vi
      .spyOn(descriptions, "describeImagesWithModel")
      .mockImplementation(overrides.describeImagesWithModel);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.resolveAutoMediaKeyProviders) {
    const spy = vi
      .spyOn(defaults, "resolveAutoMediaKeyProviders")
      .mockImplementation(overrides.resolveAutoMediaKeyProviders);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.resolveDefaultMediaModel) {
    const spy = vi
      .spyOn(defaults, "resolveDefaultMediaModel")
      .mockImplementation(overrides.resolveDefaultMediaModel);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.resolveModelAsync) {
    const spy = vi
      .spyOn(models, "resolveModelAsync")
      .mockImplementation(overrides.resolveModelAsync);
    restoreSpies.push(() => spy.mockRestore());
  }
  if (overrides.resolveImageCompressionPolicy) {
    const spy = vi
      .spyOn(execution, "prepareImageCompressionPolicy")
      .mockImplementation(overrides.resolveImageCompressionPolicy);
    restoreSpies.push(() => spy.mockRestore());
  }
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
export const resolveImageModelConfigForTool: ImageToolTestApi["resolveImageModelConfigForTool"] = (
  params,
) => getTestApi().resolveImageModelConfigForTool(params);

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
