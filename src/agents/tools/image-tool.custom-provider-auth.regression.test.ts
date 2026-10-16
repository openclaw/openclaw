import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ModelProviderConfig } from "../../config/types.models.js";
import { buildMediaUnderstandingRegistry } from "../../media-understanding/provider-registry.js";
import type { MediaUnderstandingProvider } from "../../media-understanding/types.js";
import { createAuthProfileStoreFixture } from "../auth-profiles/credential-fixtures.test-support.js";
import { getApiKeyForModelCore, hasUsableCustomProviderApiKey } from "../model-auth.js";
import { resolveImageToolFactoryAvailable } from "../openclaw-tools.media-factory-plan.js";
import {
  ONE_PIXEL_PNG_B64,
  createImageToolForTest,
  createImageWebMediaRuntime,
  makeModelDefinition,
  resolveConfiguredImageModelForTest,
  resolveImageModelConfigForTool,
  testing,
} from "./image-tool.test-support.js";
import { hasProviderAuthForTool } from "./model-config.helpers.js";

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
const mediaRuntimeMock = createImageWebMediaRuntime(async () => {
  throw new Error("expected inline image");
});
const optimizeImage = vi.fn(mediaRuntimeMock.optimizeImageBufferForWebMedia);
mediaRuntimeMock.optimizeImageBufferForWebMedia = optimizeImage;

const genericDescribe = vi.hoisted(() => vi.fn());
vi.mock("../../media-understanding/image-runtime.js", () => ({
  describeImageWithModel: genericDescribe,
  describeImagesWithModel: genericDescribe,
  describeImageWithModelPayloadTransform: genericDescribe,
  describeImagesWithModelPayloadTransform: genericDescribe,
}));

function providerConfig(
  provider: string,
  model: string,
  options: Omit<ModelProviderConfig, "models"> & { primary?: string; mode?: "replace" },
): OpenClawConfig {
  const { primary = `${provider}/${model}`, mode, ...definition } = options;
  return {
    agents: { defaults: { model: { primary } } },
    models: {
      mode,
      providers: { [provider]: { ...definition, models: [makeModelDefinition(model)] } },
    },
  };
}
function createUserReportedConfig(includeApiKey = true) {
  return providerConfig(USER_PROVIDER, USER_MODEL, {
    baseUrl: "https://example.com/v1",
    api: "openai-completions",
    ...(includeApiKey ? { apiKey: CONFIG_API_KEY } : {}),
  });
}

function createDeferredTool(config: OpenClawConfig, agentDir: string) {
  return createImageToolForTest({
    config,
    agentDir,
    deferAutoModelResolution: true,
    modelHasVision: false,
    authProfileStore: createAuthProfileStoreFixture({}),
  });
}

const inlineRequest = { path: `data:image/png;base64,${ONE_PIXEL_PNG_B64}` };

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.unstubAllEnvs();
  testing.setProviderDepsForTest();
});
const describeModel = async (params: { provider: string; model: string }) => ({
  text: `seen:${params.provider}/${params.model}`,
  model: params.model,
});

describe("image custom provider auth regression", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = tempDirs.make("openclaw-image-auth-regression-");
    optimizeImage.mockClear();
    for (const key of USER_PROVIDER_AUTH_ENV_KEYS) {
      vi.stubEnv(key, "");
    }
    testing.setProviderDepsForTest({
      buildProviderRegistry: () => new Map(),
      getMediaUnderstandingProvider: () => undefined,
      describeImageWithModel: describeModel,
      describeImagesWithModel: describeModel,
      resolveAutoMediaKeyProviders: () => [],
      resolveDefaultMediaModel: () => undefined,
      resolveRegisteredMediaUnderstandingProvider: () => undefined,
      resolveModelAsync: resolveConfiguredImageModelForTest,
      loadImageWebMediaRuntime: async () => mediaRuntimeMock,
    });
  });

  it("registers config-only AWS SDK Bedrock image models", async () => {
    for (const key of [
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
    ]) {
      vi.stubEnv(key, "");
    }
    const cfg = providerConfig(BEDROCK_PROVIDER, BEDROCK_VISION_MODEL, {
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      auth: "aws-sdk",
      api: "bedrock-converse-stream",
      primary: `${BEDROCK_PROVIDER}/text-1`,
      mode: "replace",
    });

    expect(hasProviderAuthForTool({ provider: BEDROCK_PROVIDER, cfg })).toBe(true);
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toEqual({
      primary: `${BEDROCK_PROVIDER}/${BEDROCK_VISION_MODEL}`,
    });
    expect(resolveImageToolFactoryAvailable({ config: cfg, agentDir, modelHasVision: true })).toBe(
      true,
    );
  });

  it("executes deferred fallback discovery with config-backed auth and runtime key resolution", async () => {
    const cfg = createUserReportedConfig();
    const auth = await getApiKeyForModelCore({
      model: {
        ...makeModelDefinition(USER_MODEL),
        provider: USER_PROVIDER,
        api: "openai-completions",
        baseUrl: "https://example.com/v1",
      },
      cfg,
      agentDir,
      store: createAuthProfileStoreFixture({}),
    });
    expect(auth).toMatchObject({
      apiKey: CONFIG_API_KEY,
      source: expect.stringContaining("models.json"),
    });

    const tool = createDeferredTool(cfg, agentDir);
    expect(tool).toMatchObject({ execute: expect.any(Function), name: "view_image" });

    const result = await tool.execute("regression-1", inlineRequest);

    const text = result.content.find((entry) => entry.type === "text")?.text ?? "";
    expect(text).toContain(`seen:${USER_PRIMARY}`);
    expect(text).not.toMatch(/No image model is configured/i);
    expect(optimizeImage).toHaveBeenCalledTimes(1);
  });

  it("still rejects the same fallback config when apiKey is missing", async () => {
    const cfg = createUserReportedConfig(false);
    expect(hasUsableCustomProviderApiKey(cfg, USER_PROVIDER)).toBe(false);
    expect(hasProviderAuthForTool({ provider: USER_PROVIDER, cfg })).toBe(false);
    expect(resolveImageModelConfigForTool({ cfg, agentDir })).toBeNull();

    const tool = createDeferredTool(cfg, agentDir);
    await expect(tool.execute("regression-2", inlineRequest)).rejects.toThrow(
      /No image model is configured/,
    );
  });
});

type ProviderDeps = NonNullable<Parameters<typeof testing.setProviderDepsForTest>[0]>;
const resolveProvider =
  vi.fn<NonNullable<ProviderDeps["resolveRegisteredMediaUnderstandingProvider"]>>();
const image = "data:image/png;base64,aW1hZ2U=";

function makeProvider(
  id: string,
  describeImage: NonNullable<MediaUnderstandingProvider["describeImage"]> = async () => ({
    text: id,
  }),
): MediaUnderstandingProvider {
  return { id, capabilities: ["image"], describeImage: vi.fn(describeImage) };
}

async function executeImage(params: {
  fallbacks?: string[];
  preparedProviders?: MediaUnderstandingProvider[];
  configuredProvider?: string;
  paths?: string[];
}) {
  const config: OpenClawConfig = {
    agents: {
      defaults: { imageModel: { primary: "selected/vision", fallbacks: params.fallbacks } },
    },
  };
  if (params.configuredProvider) {
    config.models = providerConfig(params.configuredProvider, "vision", {
      baseUrl: "https://example.invalid/v1",
    }).models;
  }
  const tool = createImageToolForTest({
    config,
    agentDir: "/image-provider-loading-test",
    preparedModelRuntime: params.preparedProviders
      ? ({
          mediaCapabilityProviders: { mediaUnderstandingProviders: params.preparedProviders },
        } as never)
      : undefined,
  });
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
        return buildMediaUnderstandingRegistry(overrides, cfg, preparedProviders);
      },
      resolveRegisteredMediaUnderstandingProvider: resolveProvider,
      resolveImageCompressionPolicy: async () => ({ imageCount: 1 }),
      loadImageWebMediaRuntime: async () => mediaRuntimeMock,
    });
  });

  it("uses a prepared single-image owner alias for each image", async () => {
    const owner = {
      ...makeProvider("owner", async ({ buffer }) => ({ text: buffer.toString("utf8") })),
      aliases: ["selected"],
    };
    const describeImage = vi.mocked(owner.describeImage!);
    resolveProvider.mockReturnValue(owner);
    const result = await executeImage({
      paths: [image, "data:image/png;base64,aW1hZ2UtdHdv"],
      preparedProviders: [owner],
    });

    expect(describeImage).toHaveBeenCalledTimes(2);
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
