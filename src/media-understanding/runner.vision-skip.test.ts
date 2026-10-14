import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { resolvePluginRegistryLoadCacheKey } from "../plugins/loader.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withMediaFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type TestCatalogEntry = Pick<ModelDefinitionConfig, "id" | "name" | "input"> & { provider: string };

const baseCatalog: TestCatalogEntry[] = [
  {
    id: "gpt-4.1",
    name: "GPT-4.1",
    provider: "openai",
    input: ["text", "image"] as const,
  },
];
let catalog: TestCatalogEntry[] = [...baseCatalog];
const plantedVisionSentinel = "PLANTED_VISION_DESC_zq7x";

const loadModelCatalog = vi.hoisted(() => vi.fn(async (_params: unknown) => catalog));

// These cases own native-vision routing; model compression policy has its own
// resize-boundary suite and must not bootstrap real provider runtimes here.
vi.mock("../agents/image-compression-policy.js", () => ({
  resolveImageCompressionModelPolicy: vi.fn(async () => ({})),
}));

vi.mock("../agents/model-auth.js", async () => {
  const { createAvailableModelAuthMockModule } = await import("./runner.test-mocks.js");
  return createAvailableModelAuthMockModule();
});

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const runtime =
    await vi.importActual<typeof import("../plugins/runtime.js")>("../plugins/runtime.js");
  return {
    resolvePluginCapabilityProviders: ({ key }: { key: string }) =>
      key === "mediaUnderstandingProviders"
        ? (runtime
            .getActivePluginRegistry()
            ?.mediaUnderstandingProviders.map((entry) => entry.provider) ?? [])
        : [],
  };
});

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: loadModelCatalog,
}));

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let applyMediaUnderstanding: typeof import("./apply.js").applyMediaUnderstanding;
let runCapability: typeof import("./runner.js").runCapability;

function findImageDecision(ctx: MsgContext) {
  return ctx.MediaUnderstandingDecisions?.find((decision) => decision.capability === "image");
}

function setCompatibleActiveMediaUnderstandingRegistry(
  pluginRegistry: ReturnType<typeof createEmptyPluginRegistry>,
  cfg: OpenClawConfig,
) {
  const pluginIds = loadPluginManifestRegistryCore({
    config: cfg,
    env: process.env,
  })
    .plugins.filter(
      (plugin) =>
        plugin.origin === "bundled" &&
        (plugin.contracts?.mediaUnderstandingProviders?.length ?? 0) > 0,
    )
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  cfg.plugins = {
    enabled: true,
    allow: [...new Set(pluginIds)],
    entries: Object.fromEntries(pluginIds.map((pluginId) => [pluginId, { enabled: true }])),
    slots: { memory: "none" },
  };
  const cacheKey = resolvePluginRegistryLoadCacheKey({
    config: cfg,
    env: process.env,
  });
  setActivePluginRegistry(pluginRegistry, cacheKey);
}

function withImageFixture(filePrefix: string, run: Parameters<typeof withMediaFixture>[1]) {
  return withMediaFixture(
    { filePrefix, extension: "png", mediaType: "image/png", fileContents: Buffer.from("image") },
    run,
  );
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
  setCompatibleActiveMediaUnderstandingRegistry(registry, cfg);
  return buildProviderRegistry(undefined, cfg);
}

async function runImage(
  params: Omit<Parameters<typeof runCapability>[0], "capability" | "ctx" | "media" | "attachments">,
) {
  let result: Awaited<ReturnType<typeof runCapability>> | undefined;
  await withImageFixture("openclaw-image-routing", async ({ ctx, media, cache }) => {
    result = await runCapability({
      capability: "image",
      agentDir: "/tmp",
      ...params,
      ctx,
      media,
      attachments: cache,
    });
  });
  return expectDefined(result, "image result");
}

async function applyImage(
  params: Omit<Parameters<typeof applyMediaUnderstanding>[0], "ctx" | "workspaceDir">,
  count = 1,
) {
  let result: MsgContext | undefined;
  await withImageFixture("openclaw-image-apply", async ({ mediaPath }) => {
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
    result = ctx;
  });
  return expectDefined(result, "image context");
}

function imageProvider(id: string): MediaUnderstandingProvider {
  return {
    id,
    capabilities: ["image"],
    describeImage: async ({ model }) => ({ text: plantedVisionSentinel, model }),
  };
}

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
const explicitImageConfig: OpenClawConfig = {
  tools: {
    media: {
      models: [
        { provider: "openrouter", model: "google/gemini-2.5-flash", capabilities: ["image"] },
      ],
    },
  },
};

describe("runCapability image skip", () => {
  beforeAll(async () => {
    ({ buildProviderRegistry, runCapability } = await import("./runner.js"));
    ({ applyMediaUnderstanding } = await import("./apply.js"));
  });

  beforeEach(() => {
    catalog = [...baseCatalog];
    loadModelCatalog.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.unstubAllEnvs();
  });

  it("skips imageModel fallback when MiniMax M3 supports vision", async () => {
    catalog.push({
      id: "MiniMax-M3",
      name: "MiniMax M3",
      provider: "minimax",
      input: ["text", "image"],
    });
    const describeImage = vi.fn(async ({ model }: { model: string }) => ({
      text: plantedVisionSentinel,
      model,
    }));
    const ctx = await applyImage({
      cfg: { agents: { defaults: { imageModel: { primary: "minimax/MiniMax-M3" } } } },
      providers: { minimax: { id: "minimax", capabilities: ["image"], describeImage } },
      activeModel: { provider: "minimax", model: "MiniMax-M3" },
    });
    expect(findImageDecision(ctx)).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(findImageDecision(ctx)?.attachments[0]?.attempts[0]).toMatchObject({
      outcome: "skipped",
      reason: "primary model supports vision natively",
    });
    expect(describeImage).not.toHaveBeenCalled();
    expect(ctx.Body).not.toContain(plantedVisionSentinel);
    expect(ctx.Body).not.toContain("Image attachment not");
  });

  it("records native handoff and remote failures for selected and dropped images", async () => {
    await withImageFixture("openclaw-image-url-only-no-handoff", async ({ mediaPath }) => {
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
      expect(decision?.attachments.map(({ attachmentIndex }) => attachmentIndex)).toEqual([
        0, 1, 2,
      ]);
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
    await loadModelCatalog.withImplementation(
      async () => {
        throw new Error("catalog unavailable");
      },
      async () => {
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
      },
    );
  });

  it("keeps disabled outcomes precise and suppresses markers when the vision probe fails", async () => {
    const ctx: MsgContext = {
      Body: "inspect this image",
      media: [{ path: "/tmp/image.png", contentType: "image/png" }],
    };
    await loadModelCatalog.withImplementation(
      async () => {
        throw new Error("catalog unavailable");
      },
      async () => {
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
      },
    );
  });

  it("renders disabled markers when the active model has no native vision", async () => {
    const ctx: MsgContext = {
      Body: "inspect this image",
      media: [{ path: "/tmp/image.png", contentType: "image/png" }],
    };
    await applyMediaUnderstanding({
      ctx,
      cfg: { tools: { media: { image: { enabled: false } } } },
    });
    expect(findImageDecision(ctx)).toMatchObject({
      outcome: "disabled",
      nativeVisionActive: false,
      attachmentDispositions: { 0: { kind: "capability-disabled" } },
    });
    expect(ctx.Body).toContain("[Image attachment not analyzed: image understanding is disabled]");
  });

  it("uses explicit image models even when the active model supports vision", async () => {
    const describeImage = vi.fn(async ({ model }: { model: string }) => ({
      text: plantedVisionSentinel,
      model,
    }));
    const ctx = await applyImage(
      {
        cfg: explicitImageConfig,
        providers: { openrouter: { id: "openrouter", capabilities: ["image"], describeImage } },
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
      cfg: {
        tools: {
          media: {
            models: [
              {
                provider: "openrouter",
                model: "google/gemini-2.5-flash",
                prompt: "entry prompt",
                capabilities: ["image"],
              },
            ],
          },
        },
      },
      providerRegistry: imageRegistry({
        id: "openrouter",
        capabilities: ["image"],
        describeImage: async ({ prompt, model }) => {
          seenPrompt = prompt;
          return { text: "request prompt ok", model };
        },
      }),
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
      providerRegistry: imageRegistry({
        id: "ollama",
        capabilities: ["image"],
        describeImage: async ({ model }) => {
          if (model === "moondream") {
            throw new Error("primary blocked");
          }
          return { text: `ok ${model}`, model };
        },
      }),
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
    catalog = [
      {
        id: "MiniMax-M2.7",
        name: "MiniMax M2.7",
        provider: "minimax-portal",
        input: ["text", "image"],
      },
    ];
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
    const modelAuth = await import("../agents/model-auth.js");
    const hasAvailableAuthForProvider = vi.mocked(modelAuth.hasAvailableAuthForProvider);
    hasAvailableAuthForProvider.mockClear();
    await hasAvailableAuthForProvider.withImplementation(
      async (params) => params.workspaceDir === "/tmp/openclaw-workspace",
      async () => {
        const result = await runImage({
          cfg: {},
          agentId: "vision-agent",
          agentDir: "/tmp/openclaw-agent",
          workspaceDir: "/tmp/openclaw-workspace",
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
        expect(loadModelCatalog).toHaveBeenCalledWith({
          config: {},
          agentId: "vision-agent",
          agentDir: "/tmp/openclaw-agent",
          workspaceDir: "/tmp/openclaw-workspace",
        });
        expect(loadModelCatalog.mock.calls[0]?.[0]).not.toHaveProperty("readOnly");
      },
    );
  });

  it("auto-selects configured OpenRouter image providers with a resolved model", async () => {
    let seenModel: string | undefined;
    const result = await runImage({
      cfg: {
        models: {
          providers: {
            openrouter: {
              apiKey: "test-openrouter-key",
              baseUrl: "https://openrouter.ai/api/v1",
              models: [],
            },
          },
        },
      },
      providerRegistry: imageRegistry({
        id: "openrouter",
        capabilities: ["image"],
        describeImage: async ({ model }) => {
          seenModel = model;
          return { text: "openrouter ok", model };
        },
      }),
    });
    expectImageOutput(result, "openrouter", "auto", "openrouter ok");
    expect(seenModel).toBe("auto");
  });

  it("skips configured image providers without an auto-resolvable model", async () => {
    const result = await runImage({
      cfg: {
        models: {
          providers: {
            "custom-image": {
              apiKey: "test-custom-key",
              baseUrl: "https://image.example/v1",
              models: [],
            },
          },
        },
      },
      providerRegistry: imageRegistry(imageProvider("custom-image")),
    });
    expect(result.outputs).toHaveLength(0);
    expect(result.decision.outcome).toBe("skipped");
    expect(result.decision.attachments).toEqual([{ attachmentIndex: 0, attempts: [] }]);
  });
});
