import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilityModelProviderCandidate } from "../../../packages/media-generation-core/src/capability-model-ref.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { buildMediaUnderstandingRegistry } from "../../media-understanding/provider-registry.js";
import type { MediaUnderstandingProvider } from "../../media-understanding/types.js";
import type { ImageDescriptionRequest } from "../../plugin-sdk/media-understanding.js";
import { getApiKeyForModelCore, hasUsableCustomProviderApiKey } from "../model-auth.js";
import { resolveImageToolFactoryAvailable } from "../openclaw-tools.media-factory-plan.js";
import { createImageTool } from "./image-tool.js";
import {
  ONE_PIXEL_PNG_B64,
  resolveImageModelConfigForTool,
  testing,
} from "./image-tool.test-support.js";
import { hasProviderAuthForTool } from "./model-config.helpers.js";

const buildProviderRegistry = buildMediaUnderstandingRegistry;

const USER_PROVIDER = "hatchery-qwen3.6-plus";
const USER_MODEL = "qwen3.6-plus";
const USER_PRIMARY = `${USER_PROVIDER}/${USER_MODEL}`;
const BEDROCK_PROVIDER = "amazon-bedrock";
const BEDROCK_VISION_MODEL = "vision-1";
const CONFIG_API_KEY = "sk-user-configured-key"; // pragma: allowlist secret
const USER_PROVIDER_AUTH_ENV_KEYS = [
  "HATCHERY_QWEN3_6_PLUS_API_KEY",
  "HATCHERY_QWEN3_6_PLUS_OAUTH_TOKEN",
  "QWEN3_6_PLUS_API_KEY",
  "QWEN3_6_PLUS_OAUTH_TOKEN",
];
const mediaRuntimeMock = {
  loadWebMedia: async () => {
    throw new Error("expected inline image");
  },
  optimizeImageBufferForWebMedia: vi.fn(
    async (params: { buffer: Buffer; contentType?: string; fileName?: string }) => ({
      buffer: params.buffer,
      contentType: params.contentType ?? "image/png",
      kind: "image" as const,
      fileName: params.fileName,
    }),
  ),
};

const genericDescribe = vi.hoisted(() => vi.fn());
vi.mock("../../media-understanding/image-runtime.js", () => ({
  describeImageWithModel: genericDescribe,
  describeImagesWithModel: genericDescribe,
  describeImageWithModelPayloadTransform: genericDescribe,
  describeImagesWithModelPayloadTransform: genericDescribe,
}));

function makeVisionModel(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } satisfies ModelDefinitionConfig;
}

function createUserReportedConfig(params?: { includeApiKey?: boolean }): OpenClawConfig {
  const includeApiKey = params?.includeApiKey ?? true;
  return {
    agents: {
      defaults: {
        model: { primary: USER_PRIMARY },
      },
    },
    models: {
      providers: {
        [USER_PROVIDER]: {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          ...(includeApiKey ? { apiKey: CONFIG_API_KEY } : {}),
          models: [makeVisionModel(USER_MODEL)],
        },
      },
    },
  };
}

function createBedrockSdkConfig(): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: `${BEDROCK_PROVIDER}/text-1` } } },
    models: {
      mode: "replace",
      providers: {
        [BEDROCK_PROVIDER]: {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          auth: "aws-sdk",
          api: "bedrock-converse-stream",
          models: [makeVisionModel(BEDROCK_VISION_MODEL)],
        },
      },
    },
  };
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("image custom provider auth regression", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = tempDirs.make("openclaw-image-auth-regression-");
    mediaRuntimeMock.optimizeImageBufferForWebMedia.mockClear();
    for (const key of USER_PROVIDER_AUTH_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    testing.setProviderDepsForTest({
      buildProviderRegistry: () => new Map(),
      getMediaUnderstandingProvider: () => undefined,
      describeImageWithModel: async (params: ImageDescriptionRequest) => ({
        text: `seen:${params.provider}/${params.model}`,
        model: params.model,
      }),
      describeImagesWithModel: async (params) => ({
        text: `seen:${params.provider}/${params.model}`,
        model: params.model,
      }),
      resolveAutoMediaKeyProviders: () => [],
      resolveDefaultMediaModel: () => undefined,
      resolveRegisteredMediaUnderstandingProvider: () => undefined,
      resolveModelAsync: async (provider, model) => ({
        logicalRef: { provider, model },
        model: {} as never,
        authStorage: {} as never,
        modelRegistry: {} as never,
      }),
      loadImageWebMediaRuntime: async () => mediaRuntimeMock,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    testing.setProviderDepsForTest(undefined);
  });

  it("registers config-only AWS SDK Bedrock image models", async () => {
    vi.stubEnv("AWS_PROFILE", "");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "");
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", "");
    vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "");
    const cfg = createBedrockSdkConfig();

    expect(hasProviderAuthForTool({ provider: BEDROCK_PROVIDER, cfg })).toBe(true);
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: `${BEDROCK_PROVIDER}/${BEDROCK_VISION_MODEL}`,
    });
    expect(
      resolveImageToolFactoryAvailable({
        config: cfg,
        agentDir,
        modelHasVision: true,
      }),
    ).toBe(true);
  });

  it("executes deferred fallback discovery with config-backed auth and runtime key resolution", async () => {
    // Deferred execution resolves credentials stored in config after registration.
    const cfg = createUserReportedConfig();
    const auth = await getApiKeyForModelCore({
      model: {
        ...makeVisionModel(USER_MODEL),
        provider: USER_PROVIDER,
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
      },
      cfg,
      agentDir,
    });
    expect(auth.apiKey).toBe(CONFIG_API_KEY);
    expect(auth.source).toContain("models.json");

    const tool = createImageTool({
      config: cfg,
      agentDir,
      deferAutoModelResolution: true,
      modelHasVision: false,
    });
    expect(typeof tool?.execute).toBe("function");
    expect(tool?.name).toBe("view_image");

    const result = await tool!.execute("regression-1", {
      prompt: "Read this screenshot.",
      path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
    });

    const payload = result as { content?: Array<{ type?: string; text?: string }> };
    const text = payload.content?.find((entry) => entry.type === "text")?.text ?? "";
    expect(text).toContain(`seen:${USER_PRIMARY}`);
    expect(text).not.toMatch(/No image model is configured/i);
    expect(mediaRuntimeMock.optimizeImageBufferForWebMedia).toHaveBeenCalledTimes(1);
  });

  it("still rejects the same fallback config when apiKey is missing", async () => {
    const cfg = createUserReportedConfig({ includeApiKey: false });
    expect(hasUsableCustomProviderApiKey(cfg, USER_PROVIDER)).toBe(false);
    expect(hasProviderAuthForTool({ provider: USER_PROVIDER, cfg })).toBe(false);
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();

    const tool = createImageTool({
      config: cfg,
      agentDir,
      deferAutoModelResolution: true,
      modelHasVision: false,
    });
    await expect(
      tool!.execute("regression-2", {
        prompt: "Read this screenshot.",
        path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}`,
      }),
    ).rejects.toThrow(/No image model is configured/);
  });
});

type ProviderDeps = NonNullable<Parameters<typeof testing.setProviderDepsForTest>[0]>;
const resolveProvider =
  vi.fn<NonNullable<ProviderDeps["resolveRegisteredMediaUnderstandingProvider"]>>();
const image = "data:image/png;base64,aW1hZ2U=";

function makeProvider(id: string, text = id): MediaUnderstandingProvider {
  return { id, capabilities: ["image"], describeImage: vi.fn(async () => ({ text })) };
}

async function executeImage(params: {
  fallbacks?: string[];
  preparedProviders?: MediaUnderstandingProvider[];
  configuredProvider?: string;
  paths?: string[];
}) {
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        imageModel: {
          primary: "selected/vision",
          ...(params.fallbacks ? { fallbacks: params.fallbacks } : {}),
        },
      },
    },
  };
  if (params.configuredProvider) {
    config.models = {
      providers: {
        [params.configuredProvider]: {
          baseUrl: "https://example.invalid/v1",
          models: [{ ...makeVisionModel("vision"), name: "Vision", maxTokens: 4096 }],
        },
      },
    };
  }
  const tool = createImageTool({
    config,
    agentDir: "/image-provider-loading-test",
    ...(params.preparedProviders
      ? {
          preparedModelRuntime: {
            mediaCapabilityProviders: { mediaUnderstandingProviders: params.preparedProviders },
          } as never,
        }
      : {}),
  });
  if (!tool) {
    throw new Error("expected configured image tool");
  }
  return await tool.execute(
    "image-loading",
    params.paths ? { paths: params.paths } : { path: image },
  );
}

describe("image tool provider loading", () => {
  beforeEach(() => {
    genericDescribe.mockReset().mockResolvedValue({ text: "generic image" });
    resolveProvider.mockReset();
    testing.setProviderDepsForTest({
      buildProviderRegistry: (overrides, cfg, preparedProviders) => {
        // An unrelated plugin must not block the selected provider during discovery.
        if (preparedProviders === undefined) {
          throw new Error("unrelated media plugin failed to initialize");
        }
        return buildProviderRegistry(overrides, cfg, preparedProviders);
      },
      resolveRegisteredMediaUnderstandingProvider: resolveProvider,
      resolveImageCompressionPolicy: async () => ({ imageCount: 1 }),
      loadImageWebMediaRuntime: async () => mediaRuntimeMock,
    });
  });

  afterEach(() => testing.setProviderDepsForTest());

  it("uses a prepared single-image owner alias for each image", async () => {
    const describeImage = vi.fn<NonNullable<MediaUnderstandingProvider["describeImage"]>>(
      async ({ buffer }) => ({ text: buffer.toString("utf8") }),
    );
    const owner: MediaUnderstandingProvider & CapabilityModelProviderCandidate = {
      id: "owner",
      aliases: ["selected"],
      capabilities: ["image"],
      describeImage,
    };
    resolveProvider.mockReturnValue(owner);
    const result = await executeImage({
      paths: [image, "data:image/png;base64,aW1hZ2UtdHdv"],
      preparedProviders: [owner],
    });

    expect(describeImage).toHaveBeenCalledTimes(2);
    expect(describeImage.mock.calls.map(([request]) => request.buffer.toString("utf8"))).toEqual([
      "image",
      "image-two",
    ]);
    expect(result.content).toEqual([
      { type: "text", text: "Image 1:\nimage\n\nImage 2:\nimage-two" },
    ]);
    expect(genericDescribe).not.toHaveBeenCalled();
    expect(resolveProvider).not.toHaveBeenCalled();
  });

  it("loads the next fallback owner only after the primary fails", async () => {
    const primary = makeProvider("selected");
    vi.mocked(primary.describeImage!).mockRejectedValue(new Error("rate limit"));
    resolveProvider.mockImplementation(({ providerId }) =>
      providerId === "selected" ? primary : makeProvider(providerId),
    );
    const result = await executeImage({ fallbacks: ["fallback/vision", "unused/vision"] });
    expect(result.content).toEqual([{ type: "text", text: "fallback" }]);
    expect(resolveProvider.mock.calls.map(([params]) => params.providerId)).toEqual([
      "selected",
      "fallback",
    ]);
  });

  it("keeps config-backed generic image dispatch with an empty prepared family", async () => {
    const result = await executeImage({ configuredProvider: "selected", preparedProviders: [] });
    expect(result.content).toEqual([{ type: "text", text: "generic image" }]);
    expect(genericDescribe).toHaveBeenCalledWith(expect.objectContaining({ provider: "selected" }));
    expect(resolveProvider).not.toHaveBeenCalled();
  });
});
