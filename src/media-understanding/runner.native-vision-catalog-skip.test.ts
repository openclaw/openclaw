// Regression test for the activeModelSupportsNativeVision catalog-skip fix:
// a configured model's own `input` should answer the native-vision probe
// directly, without paying a catalog load, like explicitImageModelVisionStatus.
import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";

type TestCatalogEntry = { id: string; name: string; provider: string; input: readonly string[] };

const baseCatalog: TestCatalogEntry[] = [
  { id: "gpt-4.1", name: "GPT-4.1", provider: "openai", input: ["text", "image"] as const },
];
let catalog: TestCatalogEntry[] = [...baseCatalog];

const loadModelCatalog = vi.hoisted(() => vi.fn(async (_params: unknown) => catalog));

// Same mock set as runner.vision-skip.test.ts at this commit, so importing
// runner.js here bootstraps identically to the sibling suite.
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
        ? (runtime.getActivePluginRegistry()?.mediaUnderstandingProviders.map((entry) => entry.provider) ?? [])
        : [],
  };
});

vi.mock("../agents/model-catalog.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/model-catalog.js")>(
    "../agents/model-catalog.js",
  );
  return { ...actual };
});

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: loadModelCatalog,
}));

let buildProviderRegistry: typeof import("./runner.js").buildProviderRegistry;
let runCapability: typeof import("./runner.js").runCapability;

describe("activeModelSupportsNativeVision - declared image input skips the catalog load", () => {
  beforeAll(async () => {
    vi.doMock("../agents/prepared-model-catalog.js", () => ({
      loadProviderScopedThinkingCatalog: vi.fn(async () => []),
      readPreparedModelCatalog: loadModelCatalog,
    }));
    ({ buildProviderRegistry, runCapability } = await import("./runner.js"));
  });

  beforeEach(() => {
    catalog = [...baseCatalog];
    loadModelCatalog.mockClear();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function runImageTurn(
    cfg: OpenClawConfig,
    activeModel: { provider: string; model: string },
  ) {
    const ctx: MsgContext = { media: [{ path: "/tmp/image.png", contentType: "image/png" }] };
    const media = normalizeMediaAttachments(ctx);
    const cache = createMediaAttachmentCache(media);
    try {
      return await runCapability({
        capability: "image",
        cfg,
        ctx,
        attachments: cache,
        media,
        providerRegistry: buildProviderRegistry(),
        activeModel,
      });
    } finally {
      await cache.cleanup();
    }
  }

  it("a model with a declared image input never touches the catalog", async () => {
    const cfg = {
      models: {
        providers: { "usage-proxy": { models: [{ id: "gpt-5.4", input: ["text", "image"] }] } },
      },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "usage-proxy", model: "gpt-5.4" });

    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    const attempt = expectDefined(result.decision.attachments[0], "attachment 0").attempts[0];
    expect(attempt?.reason).toBe("primary model supports vision natively");
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("a configured text-only model still falls back to the catalog, unchanged", async () => {
    // An explicitly configured entry that declares text-only input.
    const cfg = {
      models: { providers: { openai: { models: [{ id: "gpt-4.1", input: ["text"] }] } } },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "openai", model: "gpt-4.1" });

    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("a model with no models.providers entry at all still loads the catalog, unchanged", async () => {
    const cfg = {} as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "openai", model: "gpt-4.1" });

    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("a models-add row with declared image input takes the catalog path", async () => {
    // Runtime resolution may prefer discovered metadata over a models-add row
    // (model.configured-overrides.ts), so only the catalog may answer here.
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-4.1", input: ["text", "image"], metadataSource: "models-add" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "openai", model: "gpt-4.1" });

    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
  });

  it("a declared image input overrides a catalog with no matching entry, changing the answer to true", async () => {
    catalog = []; // no catalog entry for this provider/model at all
    const cfg = {
      models: {
        providers: { "usage-proxy": { models: [{ id: "gpt-5.4", input: ["text", "image"] }] } },
      },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "usage-proxy", model: "gpt-5.4" });

    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("a declared image input overrides a catalog that explicitly disagrees (lists the same model as text-only), changing the answer to true", async () => {
    // The catalog names this exact provider/model as text-only.
    catalog = [{ id: "gpt-5.4", name: "GPT-5.4", provider: "usage-proxy", input: ["text"] as const }];
    const cfg = {
      models: {
        providers: { "usage-proxy": { models: [{ id: "gpt-5.4", input: ["text", "image"] }] } },
      },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "usage-proxy", model: "gpt-5.4" });

    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("a MiniMax M2.x entry with declared image input still returns false, no catalog load", async () => {
    const cfg = {
      models: { providers: { minimax: { models: [{ id: "MiniMax-M2.7", input: ["text", "image"] }] } } },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "minimax", model: "MiniMax-M2.7" });

    expect(result.decision).toMatchObject({ nativeVisionActive: false });
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("known limitation: a second declared image model still pays the catalog load, but answers correctly", async () => {
    catalog = [
      ...baseCatalog,
      { id: "gpt-4.1-second", name: "GPT-4.1 second", provider: "openai", input: ["text", "image"] as const },
    ];
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [
              { id: "gpt-4.1", input: ["text", "image"] },
              { id: "gpt-4.1-second", input: ["text", "image"] },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    const result = await runImageTurn(cfg, { provider: "openai", model: "gpt-4.1-second" });

    // resolveConfiguredImageModel returns the FIRST image-capable entry under
    // the provider, not the one matching the active model id, so the shortcut
    // misses here -- but the catalog fallback still answers right.
    expect(result.decision).toMatchObject({ outcome: "skipped", nativeVisionActive: true });
    expect(loadModelCatalog).toHaveBeenCalledTimes(1);
  });
});
