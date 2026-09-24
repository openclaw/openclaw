import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "../../media-understanding/defaults.js";
import type {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "../../media-understanding/provider-registry.js";
import type { ImageCompressionPolicy, WebMediaResult } from "../../media/web-media.js";
import type {
  describeImageWithModel,
  describeImagesWithModel,
  MediaUnderstandingProvider,
} from "../../plugin-sdk/media-understanding.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.js";
import type {
  coerceImageAssistantText,
  decodeDataUrl,
  hasImageReasoningOnlyResponse,
  ImageModelConfig,
} from "./image-tool.helpers.js";
import "./image-tool.js";

type ResolveModelAsync = (typeof import("../embedded-agent-runner/model.js"))["resolveModelAsync"];

type ImageToolLoadWebMediaOptions = {
  maxBytes?: number;
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
  imageCompression?: ImageCompressionPolicy;
  localRoots?: readonly string[] | "any";
  inboundRoots?: readonly string[];
  ssrfPolicy?: ReturnType<
    (typeof import("./media-tool-shared.js"))["resolveRemoteMediaSsrfPolicy"]
  >;
  readIdleTimeoutMs?: number;
  requestInit?: RequestInit;
};

type ImageWebMediaRuntime = {
  loadWebMedia(mediaUrl: string, options?: ImageToolLoadWebMediaOptions): Promise<WebMediaResult>;
  optimizeImageBufferForWebMedia: (typeof import("../../media/web-media.js"))["optimizeImageBufferForWebMedia"];
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
  decodeDataUrl: typeof decodeDataUrl;
  coerceImageAssistantText: typeof coerceImageAssistantText;
  hasImageReasoningOnlyResponse: typeof hasImageReasoningOnlyResponse;
  resolveImageToolMaxTokens(
    modelMaxTokens: number | undefined,
    requestedMaxTokens?: number,
  ): number;
  resolveImageCompressionPolicy: ResolveImageCompressionPolicy;
  setProviderDepsForTest(overrides?: Partial<ImageToolProviderDeps>): void;
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

export const testing = getTestApi();
export const resolveImageModelConfigForTool: ImageToolTestApi["resolveImageModelConfigForTool"] = (
  params,
) => testing.resolveImageModelConfigForTool(params);

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
