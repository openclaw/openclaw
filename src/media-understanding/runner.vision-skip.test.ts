import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import type { MediaUnderstandingModelConfig } from "../config/types.tools.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { withMediaFixture } from "./runner.test-utils.js";
import type { MediaUnderstandingProvider } from "./types.js";

type TestCatalogEntry = Pick<ModelDefinitionConfig, "id" | "name" | "input"> & { provider: string };

const baseCatalog = [catalogModel("openai", "gpt-4.1", "GPT-4.1")];
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
  catalog = [...baseCatalog];
  loadModelCatalog.mockClear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  vi.unstubAllEnvs();
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
