import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasAvailableAuthForProvider as checkAvailableAuth } from "../agents/model-auth.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import type { ImageCompressionModelPolicy } from "../media/web-media.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { MediaAttachmentCache } from "./attachments.cache.js";
import { mediaModels } from "./media-config.test-support.js";
import { runMediaFixture } from "./runner-case.test-support.js";
import { runProviderEntry } from "./runner.entries.js";
import { resolveAutoImageModel } from "./runner.js";
import { withMediaFixture } from "./runner.test-utils.js";
import type { ImageDescriptionRequest, MediaUnderstandingProvider } from "./types.js";

type TestCatalogEntry = Pick<ModelDefinitionConfig, "id" | "name" | "input"> & { provider: string };

const baseCatalog = [catalogModel("openai", "gpt-4.1", "GPT-4.1")];
let catalog: TestCatalogEntry[] = [...baseCatalog];
const plantedVisionSentinel = "PLANTED_VISION_DESC_zq7x";

const loadModelCatalog = vi.hoisted(() => vi.fn(async (_params: unknown) => catalog));
const discover = vi.hoisted(() => vi.fn());
const imagePolicy = vi.hoisted(() => vi.fn<() => Promise<ImageCompressionModelPolicy>>());
const selectionAuth = vi.mocked(checkAvailableAuth);

// mock-isolation: Routing and resize cases use fixed policy without provider runtime bootstrap.
vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: imagePolicy,
}));

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

// mock-isolation: Synthetic discovery and failure spies must not load installed plugins.
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: discover,
}));

// mock-isolation: Supply only each scenario's catalog, without provider discovery.
vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: loadModelCatalog,
}));

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;
let runCapability: typeof import("./runner.js").runCapability;
beforeAll(async () => {
  ({ buildProviderRegistry, runCapability } = await import("./runner.js"));
  ({ applyMediaUnderstanding } = await import("./apply.js"));
});

function findImageDecision(ctx: MsgContext) {
  return ctx.MediaUnderstandingDecisions?.find((decision) => decision.capability === "image");
}

type ImageFixture = Parameters<Parameters<typeof withMediaFixture>[1]>[0];
async function withImageFixture<T>(run: (fixture: ImageFixture) => Promise<T>): Promise<T> {
  let result: { value: T } | undefined;
  await withMediaFixture(
    {
      filePrefix: "openclaw-image",
      extension: "png",
      mediaType: "image/png",
      fileContents: Buffer.from("image"),
    },
    async (fixture) => {
      result = { value: await run(fixture) };
    },
  );
  return expectDefined(result, "image fixture result").value;
}

function imageModel(id: string): ModelDefinitionConfig {
  return {
    id,
    name: id,
    input: ["text", "image"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 128,
  };
}

function activateProvider(
  cfg: OpenClawConfig,
  provider: MediaUnderstandingProvider,
  pluginId = provider.id,
) {
  const registry = createEmptyPluginRegistry();
  registry.mediaUnderstandingProviders.push({
    pluginId,
    pluginName: pluginId,
    source: "test",
    provider,
  });
  // The capability resolver mock reads this registry directly, without a loader cache key.
  setActivePluginRegistry(registry);
  return buildProviderRegistry(undefined, cfg);
}

function runImage(
  params: Omit<Parameters<typeof runCapability>[0], "capability" | "ctx" | "media" | "attachments">,
) {
  return withImageFixture(({ ctx, media, cache }) =>
    runCapability({
      capability: "image",
      agentDir: "/tmp",
      ...params,
      ctx,
      media,
      attachments: cache,
    }),
  );
}

function applyImage(
  params: Omit<Parameters<typeof applyMediaUnderstanding>[0], "ctx" | "workspaceDir">,
  count = 1,
) {
  return withImageFixture(async ({ mediaPath }) => {
    const ctx: MsgContext = {
      Body: "please inspect this image",
      media: Array.from({ length: count }, () => ({ path: mediaPath, contentType: "image/png" })),
    };
    await applyMediaUnderstanding({
      agentDir: "/tmp",
      ...params,
      ctx,
      workspaceDir: path.dirname(mediaPath),
    });
    return ctx;
  });
}

function unavailableCatalog(run: () => Promise<void>) {
  return loadModelCatalog.withImplementation(async () => {
    throw new Error("catalog unavailable");
  }, run);
}
function catalogModel(provider: string, id: string, name = id): TestCatalogEntry {
  return { id, name, provider, input: ["text", "image"] };
}

function imageProvider(
  id: string,
  describeImage: MediaUnderstandingProvider["describeImage"] = async ({ model }) => ({
    text: plantedVisionSentinel,
    model,
  }),
): MediaUnderstandingProvider {
  return { id, capabilities: ["image"], describeImage };
}

function imageConfig(models: MediaUnderstandingModelConfig[]): OpenClawConfig {
  return { tools: { media: { models } } };
}
function configuredProvider(id: string, baseUrl: string, apiKey?: string): OpenClawConfig {
  return { models: { providers: { [id]: { baseUrl, apiKey, models: [] } } } };
}
const describeSentinel = () =>
  vi.fn(async ({ model }: { model: string }) => ({ text: plantedVisionSentinel, model }));

function imageRegistry(provider: MediaUnderstandingProvider) {
  return new Map([[provider.id, provider]]);
}

function expectImageOutput(
  result: Awaited<ReturnType<typeof runCapability>>,
  provider: string,
  model: string,
  text = plantedVisionSentinel,
) {
  expect(result.decision.outcome).toBe("success");
  expect(result.outputs).toEqual([
    { kind: "image.description", attachmentIndex: 0, provider, model, text },
  ]);
}

const activeVisionModel = { provider: "openai", model: "gpt-4.1" };
const explicitImageConfig = imageConfig([
  { provider: "openrouter", model: "google/gemini-2.5-flash", capabilities: ["image"] },
]);

beforeEach(() => {
  imagePolicy.mockReset().mockResolvedValue({});
  catalog = [...baseCatalog];
  loadModelCatalog.mockClear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  discover
    .mockReset()
    .mockImplementation(({ key }: { key: string }) =>
      key === "mediaUnderstandingProviders"
        ? (getActivePluginRegistry()?.mediaUnderstandingProviders.map((entry) => entry.provider) ??
          [])
        : [],
    );
  selectionAuth.mockReset().mockResolvedValue(true);
  vi.unstubAllEnvs();
});

describe("automatic media selection", () => {
  beforeEach(() => {
    catalog = [];
  });

  it("resolves explicit image defaults when fallback discovery is unavailable", async () => {
    discover.mockImplementation(() => {
      throw new Error("fallback provider discovery unavailable");
    });
    await expect(
      resolveAutoImageModel({
        cfg: {
          agents: { defaults: { imageModel: { primary: "openrouter/google/gemini-2.5-flash" } } },
        },
        activeModel: activeVisionModel,
      }),
    ).resolves.toEqual({ provider: "openrouter", model: "google/gemini-2.5-flash" });
  });

  it.each(["manifest", "config"] as const)(
    "auto-selects hookless image providers from %s",
    async (source) => {
      const provider = "selection-image";
      const cfg: OpenClawConfig = {};
      if (source === "config") {
        cfg.models = mediaModels(provider, "vision", ["text", "image"]);
      } else {
        activateProvider(cfg, {
          id: provider,
          capabilities: ["image"],
          defaultModels: { image: "vision" },
          autoPriority: { image: 1 },
        });
      }
      expect(await resolveAutoImageModel({ cfg })).toEqual({ provider, model: "vision" });
      expect(selectionAuth).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ provider }));
    },
  );

  it.each(["image", "video"] as const)(
    "normalizes the active %s provider alias",
    async (capability) => {
      const providerRegistry = activateProvider(
        {},
        {
          id: "google",
          capabilities: ["image", "video"],
          describeImage: async ({ model }) => ({ text: "image", model }),
          describeVideo: async ({ model }) => ({ text: "video", model }),
        },
      );
      const activeModel = { provider: " GEMINI ", model: "selected-model" };
      let outcome: { provider?: string; model?: string } | null;
      if (capability === "image") {
        outcome = await resolveAutoImageModel({ cfg: {}, activeModel });
      } else {
        const result = await runMediaFixture("video", "media-selection-alias", {
          cfg: {},
          activeModel,
          providerRegistry,
        });
        expect(result.decision.outcome).toBe("success");
        expect(result.outputs).toHaveLength(1);
        outcome = result.outputs[0] ?? null;
      }
      expect(outcome).toMatchObject({ model: "selected-model", provider: "google" });
      expect(selectionAuth).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ provider: "google" }),
      );
    },
  );

  it("checks audio providers once in priority order until auth is available", async () => {
    selectionAuth.mockImplementation(async ({ provider }) => provider === "second");
    const providers = ["first", "second"].map((id, priority): MediaUnderstandingProvider => ({
      id,
      capabilities: ["audio"],
      autoPriority: { audio: priority },
      defaultModels: { audio: `${id}-transcription` },
      transcribeAudio: async ({ model }) => ({ text: id, model }),
    }));
    const result = await runMediaFixture("audio", "media-selection-provider-order", {
      cfg: {},
      providerRegistry: new Map(providers.map((provider) => [provider.id, provider])),
    });
    expect(selectionAuth.mock.calls.map(([{ provider }]) => provider)).toEqual(["first", "second"]);
    expect(result.outputs).toEqual([
      {
        kind: "audio.transcription",
        attachmentIndex: 0,
        provider: "second",
        model: "second-transcription",
        text: "second",
      },
    ]);
    expect(result.decision.outcome).toBe("success");
  });
});

it("skips imageModel fallback when MiniMax M3 supports vision", async () => {
  catalog.push(catalogModel("minimax", "MiniMax-M3", "MiniMax M3"));
  const describeImage = describeSentinel();
  const ctx = await applyImage({
    cfg: { agents: { defaults: { imageModel: { primary: "minimax/MiniMax-M3" } } } },
    providers: { minimax: imageProvider("minimax", describeImage) },
    activeModel: { provider: "minimax", model: "MiniMax-M3" },
  });
  expect(findImageDecision(ctx)).toMatchObject({
    outcome: "skipped",
    nativeVisionActive: true,
    attachments: [
      { attempts: [{ outcome: "skipped", reason: "primary model supports vision natively" }] },
    ],
  });
  expect(describeImage).not.toHaveBeenCalled();
  expect(ctx.Body).not.toContain(plantedVisionSentinel);
  expect(ctx.Body).not.toContain("Image attachment not");
});

it("records native handoff and remote failures for selected and dropped images", async () => {
  await withImageFixture(async ({ mediaPath }) => {
    const ctx: MsgContext = {
      Body: "please inspect these images",
      media: [
        { path: mediaPath, contentType: "image/png" },
        { url: "https://cdn.example.test/photos/second.png", contentType: "image/png" },
        { url: "media://inbound/third.png", contentType: "image/png" },
        { path: mediaPath, contentType: "image/png" },
        { url: "https://cdn.example.test/photos/fifth.png", contentType: "image/png" },
      ],
    };
    await applyMediaUnderstanding({
      ctx,
      cfg: { tools: { media: { image: { attachments: { mode: "all", maxAttachments: 3 } } } } },
      agentDir: "/tmp",
      workspaceDir: path.dirname(mediaPath),
      activeModel: activeVisionModel,
    });
    const decision = findImageDecision(ctx);
    expect(decision?.outcome).toBe("skipped");
    expect(decision?.attachments.map(({ attachmentIndex }) => attachmentIndex)).toEqual([0, 1, 2]);
    expect(decision?.attachmentDispositions).toEqual({
      0: { kind: "handed-to-native-vision" },
      1: { kind: "failed", reason: "remote-url image is not natively deliverable" },
      2: { kind: "handed-to-native-vision" },
      3: { kind: "not-selected" },
      4: { kind: "failed", reason: "remote-url image is not natively deliverable" },
    });
    expect(ctx.Body).toContain("[Image attachment could not be analyzed]");
    expect(ctx.BodyForAgent).toContain("[Image attachment could not be analyzed]");
    expect(ctx.Body).not.toContain("not processed");
  });
});

it("runs explicit image models untouched by native-vision probe failure", async () => {
  await unavailableCatalog(async () => {
    const ctx = await applyImage({
      cfg: explicitImageConfig,
      providers: { openrouter: imageProvider("openrouter") },
      activeModel: activeVisionModel,
    });
    expect(ctx.Body).toContain(plantedVisionSentinel);
    expect(findImageDecision(ctx)).toMatchObject({
      outcome: "success",
      attachmentDispositions: { 0: { kind: "handled" } },
    });
    expect(findImageDecision(ctx)).not.toHaveProperty("nativeVisionActive");
  });
});

it("keeps disabled outcomes precise and suppresses markers when the vision probe fails", async () => {
  const ctx: MsgContext = {
    Body: "inspect this image",
    media: [{ path: "/tmp/image.png", contentType: "image/png" }],
  };
  await unavailableCatalog(async () => {
    await applyMediaUnderstanding({
      ctx,
      cfg: { tools: { media: { image: { enabled: false } } } },
      activeModel: activeVisionModel,
    });
    expect(findImageDecision(ctx)).toMatchObject({
      outcome: "disabled",
      attachmentDispositions: { 0: { kind: "capability-disabled" } },
    });
    expect(findImageDecision(ctx)).not.toHaveProperty("nativeVisionActive");
    expect(ctx.Body).not.toContain("not analyzed");
  });
});

it("uses explicit image models even when the active model supports vision", async () => {
  const describeImage = describeSentinel();
  const ctx = await applyImage(
    {
      cfg: explicitImageConfig,
      providers: { openrouter: imageProvider("openrouter", describeImage) },
      activeModel: activeVisionModel,
    },
    4,
  );
  expect(findImageDecision(ctx)).toMatchObject({
    outcome: "success",
    nativeVisionActive: true,
    attachmentDispositions: {
      1: { kind: "not-selected" },
      2: { kind: "not-selected" },
      3: { kind: "not-selected" },
    },
  });
  expect(describeImage).toHaveBeenCalledOnce();
  expect(ctx.Body).toContain(plantedVisionSentinel);
  expect(ctx.Body).not.toContain("attachment limit reached");
});

it("lets per-request image prompts override entry prompts", async () => {
  let seenPrompt: string | undefined;
  const result = await runImage({
    cfg: imageConfig([
      {
        provider: "openrouter",
        model: "google/gemini-2.5-flash",
        prompt: "entry prompt",
        capabilities: ["image"],
      },
    ]),
    providerRegistry: imageRegistry(
      imageProvider("openrouter", async ({ prompt, model }) => {
        seenPrompt = prompt;
        return { text: "request prompt ok", model };
      }),
    ),
    request: { prompt: "Use this request prompt" },
    activeModel: activeVisionModel,
  });
  expect(result.decision.outcome).toBe("success");
  expect(seenPrompt).toBe("Use this request prompt");
});

it("skips malformed image defaults and runs providerless fallbacks on their configured provider", async () => {
  const result = await runImage({
    cfg: {
      agents: {
        defaults: {
          imageModel: { primary: "openrouter/", fallbacks: ["moondream", "qwen2.5vl:7b"] },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            models: [imageModel("moondream"), imageModel("qwen2.5vl:7b")],
          },
        },
      },
    },
    providerRegistry: imageRegistry(
      imageProvider("ollama", async ({ model }) => {
        if (model === "moondream") {
          throw new Error("primary blocked");
        }
        return { text: `ok ${model}`, model };
      }),
    ),
  });
  expectImageOutput(result, "ollama", "qwen2.5vl:7b", "ok qwen2.5vl:7b");
  expect(result.decision.attachments[0]?.attempts).toEqual([
    expect.objectContaining({
      type: "provider",
      provider: "ollama",
      model: "moondream",
      outcome: "failed",
    }),
    expect.objectContaining({
      type: "provider",
      provider: "ollama",
      model: "qwen2.5vl:7b",
      outcome: "success",
    }),
  ]);
});

it("routes legacy MiniMax chat models through VLM despite catalog image input", async () => {
  catalog = [catalogModel("minimax-portal", "MiniMax-M2.7", "MiniMax M2.7")];
  vi.stubEnv("MINIMAX_API_KEY", "test-minimax-key");
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        "minimax-portal": {
          baseUrl: "https://api.minimax.io/anthropic",
          models: [imageModel("MiniMax-M2.7")],
        },
      },
    },
  };
  const providerRegistry = activateProvider(
    cfg,
    { ...imageProvider("minimax-portal"), defaultModels: { image: "MiniMax-VL-01" } },
    "minimax",
  );
  const result = await runImage({
    cfg,
    providerRegistry,
    activeModel: { provider: "minimax-portal", model: "MiniMax-M2.7" },
  });
  expectImageOutput(result, "minimax-portal", "MiniMax-VL-01");
});

it("passes workspace and agent context to auth and writable catalog reads", async () => {
  const { hasAvailableAuthForProvider: checkAuth } = await import("../agents/model-auth.js");
  const hasAvailableAuthForProvider = vi.mocked(checkAuth);
  hasAvailableAuthForProvider.mockClear();
  const scope = {
    agentId: "vision-agent",
    agentDir: "/tmp/openclaw-agent",
    workspaceDir: "/tmp/openclaw-workspace",
  };
  await hasAvailableAuthForProvider.withImplementation(
    async (params) => params.workspaceDir === "/tmp/openclaw-workspace",
    async () => {
      const result = await runImage({
        cfg: {},
        ...scope,
        providerRegistry: imageRegistry(imageProvider("workspace-vision")),
        activeModel: { provider: "workspace-vision", model: "vision-v1" },
      });
      expectImageOutput(result, "workspace-vision", "vision-v1");
      expect(hasAvailableAuthForProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "workspace-vision",
          agentDir: "/tmp/openclaw-agent",
          workspaceDir: "/tmp/openclaw-workspace",
        }),
      );
      expect(loadModelCatalog).toHaveBeenCalledWith({ config: {}, ...scope });
      expect(loadModelCatalog.mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
    },
  );
});

it("auto-selects configured OpenRouter image providers with a resolved model", async () => {
  let seenModel: string | undefined;
  const result = await runImage({
    cfg: configuredProvider("openrouter", "https://openrouter.ai/api/v1", "test-openrouter-key"),
    providerRegistry: imageRegistry(
      imageProvider("openrouter", async ({ model }) => {
        seenModel = model;
        return { text: "openrouter ok", model };
      }),
    ),
  });
  expectImageOutput(result, "openrouter", "auto", "openrouter ok");
  expect(seenModel).toBe("auto");
});

it("skips configured image providers without an auto-resolvable model", async () => {
  const result = await runImage({
    cfg: configuredProvider("custom-image", "https://image.example/v1", "test-custom-key"),
    providerRegistry: imageRegistry(imageProvider("custom-image")),
  });
  expect(result.outputs).toHaveLength(0);
  expect(result.decision.outcome).toBe("skipped");
  expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
});

describe("image resizing", () => {
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
});

describe("apply registry lifetime", () => {
  const activeModel = { provider: "usage-proxy", model: "gpt-5.4" };
  const registryBuild = vi.fn();
  const visionConfig: OpenClawConfig = {
    models: mediaModels(activeModel.provider, activeModel.model, ["text", "image"]),
  };
  function configWithModels(capabilities?: ("image" | "audio" | "video")[]): OpenClawConfig {
    return {
      ...visionConfig,
      ...(capabilities
        ? { tools: { media: { models: [{ provider: activeModel.provider, capabilities }] } } }
        : {}),
    };
  }
  function imageContext(withAudio = false): MsgContext {
    return {
      media: [
        { path: "/tmp/image.png", contentType: "image/png" },
        ...(withAudio ? [{ path: "/tmp/note.ogg", contentType: "audio/ogg" }] : []),
      ],
    };
  }
  const apply = (ctx: MsgContext, cfg: OpenClawConfig) =>
    applyMediaUnderstanding({ ctx, cfg, activeModel });
  const breakRegistry = () =>
    registryBuild.mockImplementation(() => {
      throw new Error("registry build failed");
    });
  beforeEach(() => {
    catalog = [catalogModel(activeModel.provider, activeModel.model, "GPT-5.4")];
    registryBuild.mockReset();
    discover.mockImplementation(({ key }: { key: string }) => {
      if (key === "mediaUnderstandingProviders") {
        registryBuild();
      }
      return [];
    });
  });

  it.each([
    ["explicit image model", configWithModels(["image"]), false, ["text", "image"]],
    ["text-only model", {}, false, ["text"]],
    ["mixed image and audio", visionConfig, true, ["text", "image"]],
  ] as const)("builds the registry once for %s", async (_name, cfg, audio, input) => {
    catalog = [{ ...catalogModel(activeModel.provider, activeModel.model), input: [...input] }];
    await apply(imageContext(audio), cfg);
    expect(registryBuild).toHaveBeenCalledTimes(1);
  });

  it("rejects apply on registry failure without partially recording decisions", async () => {
    breakRegistry();
    catalog = [{ ...catalogModel(activeModel.provider, activeModel.model), input: ["text"] }];
    const ctx = imageContext(true);
    await expect(apply(ctx, {})).rejects.toThrow("registry build failed");
    expect(registryBuild).toHaveBeenCalledTimes(1);
    expect(ctx.MediaUnderstandingDecisions).toBeUndefined();
  });

  it.each([
    { name: "no shared models", capabilities: undefined },
    { name: "audio and video shared models", capabilities: ["audio", "video"] },
  ] as const)("keeps native vision with $name", async ({ capabilities }) => {
    breakRegistry();
    const ctx = imageContext();
    await expect(
      apply(ctx, configWithModels(capabilities ? [...capabilities] : undefined)),
    ).resolves.toEqual({ extractedFileImages: [] });
    expect(ctx.MediaUnderstandingDecisions).toContainEqual(
      expect.objectContaining({
        capability: "image",
        outcome: "skipped",
        nativeVisionActive: true,
        attachmentDispositions: { 0: { kind: "handed-to-native-vision" } },
      }),
    );
    expect(registryBuild).not.toHaveBeenCalled();
  });
});
