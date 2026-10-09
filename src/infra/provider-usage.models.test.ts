import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import { AuthStorage } from "../agents/sessions/auth-storage.js";
import { ModelRegistry } from "../agents/sessions/model-registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createUsageModelBaseUrlResolver } from "./provider-usage.models.js";

const runtime = vi.hoisted(() => ({ published: vi.fn(), acquire: vi.fn(), dispose: vi.fn() }));
vi.mock("../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/prepared-model-runtime.js")>()),
  getPreparedModelRuntimeSnapshot: runtime.published,
  acquireReadOnlyPreparedModelRuntime: runtime.acquire,
}));
vi.mock("../agents/model-discovery-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-discovery-context.js")>()),
  resolveModelPluginMetadataSnapshot: () => undefined,
}));
vi.mock("../plugins/manifest-contract-eligibility.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/manifest-contract-eligibility.js")>()),
  loadManifestMetadataSnapshot: () => ({
    plugins: [{ modelCatalog: { providers: { kimi: { defaultModel: "test-model" } } } }],
  }),
}));

const official = "https://api.kimi.com/coding/";
const proxy = "https://proxy.example.test/coding/";
const family = ["kimi", "kimi-code", "kimi-coding"];
const provider = (baseUrl: string, modelBaseUrl?: string) => ({
  baseUrl,
  api: "anthropic-messages" as const,
  models: [
    {
      id: "test-model",
      name: "Test model",
      reasoning: false,
      input: ["text" as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
      ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
    },
  ],
});

function snapshot(config: OpenClawConfig, sources: unknown, extraStatic = {}) {
  const authStorage = AuthStorage.inMemory({});
  const registry = ModelRegistry.create(authStorage, "/test-agent/models.json", {
    config,
    modelsJsonContents: typeof sources === "string" ? sources : JSON.stringify(sources),
    pluginCatalogs: [],
    includePluginCatalogs: false,
    staticProviderConfigs: { kimi: provider(official), ...extraStatic },
  });
  const createStores = vi.fn(() => ({ authStorage, modelRegistry: registry }));
  return {
    config,
    isCurrent: () => true,
    createStores,
    modelCatalog: { entries: registry.getAll(), routeVariants: registry.getAll() },
  } as unknown as PreparedModelRuntimeSnapshot;
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.published.mockReturnValue(undefined);
  runtime.dispose.mockResolvedValue(undefined);
});

describe("usage effective model routes", () => {
  it.each([
    { root: official, authored: proxy, expected: proxy },
    { root: proxy, authored: official, expected: official },
    { root: official, authored: official, model: proxy, expected: proxy },
  ])(
    "uses registry precedence for $root / $authored / $model",
    async ({ root, authored, model, expected }) => {
      const config: OpenClawConfig = { models: { providers: { kimi: provider(root, model) } } };
      const prepared = snapshot(config, { providers: { kimi: provider(authored) } });
      runtime.published.mockReturnValue(prepared);
      const resolve = createUsageModelBaseUrlResolver({
        config,
        agentDir: "/test-agent",
        providerIds: ["kimi"],
      });
      expect(await resolve(family)).toEqual([expected]);
      expect(await resolve(family)).toEqual([expected]);
      expect(prepared.createStores).toHaveBeenCalledOnce();
      expect(runtime.acquire).not.toHaveBeenCalled();
    },
  );

  it("keeps custom routes under every credential alias in the same family", async () => {
    const config = {};
    runtime.published.mockReturnValue(
      snapshot(config, { providers: { "kimi-coding": provider(proxy) } }),
    );
    const resolve = createUsageModelBaseUrlResolver({
      config,
      agentDir: "/test-agent",
      providerIds: ["kimi"],
    });
    expect(await resolve(family)).toEqual([official, proxy].toSorted());
  });

  it("uses replace-mode registry semantics instead of reviving an authored proxy", async () => {
    const config: OpenClawConfig = {
      models: { mode: "replace", providers: { kimi: provider(official) } },
    };
    runtime.published.mockReturnValue(snapshot(config, { providers: { kimi: provider(proxy) } }));
    const resolve = createUsageModelBaseUrlResolver({
      config,
      agentDir: "/test-agent",
      providerIds: ["kimi"],
    });
    expect(await resolve(family)).toEqual([official]);
  });

  it("does not authorize salvaged official rows from malformed authored inventory", async () => {
    const config = {};
    runtime.published.mockReturnValue(snapshot(config, "{invalid"));
    const resolve = createUsageModelBaseUrlResolver({
      config,
      agentDir: "/test-agent",
      providerIds: ["kimi"],
    });
    expect(await resolve(family)).toBeUndefined();
  });

  it("rejects a current publication belonging to a different config before using its routes", async () => {
    const oldConfig: OpenClawConfig = { models: { providers: { kimi: provider(official) } } };
    const config: OpenClawConfig = { models: { providers: { kimi: provider(proxy, proxy) } } };
    const published = snapshot(oldConfig, { providers: {} });
    const replacement = snapshot(config, { providers: {} });
    runtime.published.mockReturnValue(published);
    runtime.acquire.mockResolvedValue({
      snapshot: replacement,
      [Symbol.asyncDispose]: runtime.dispose,
    });
    const resolve = createUsageModelBaseUrlResolver({
      config,
      agentDir: "/test-agent",
      providerIds: ["kimi"],
    });
    expect(await resolve(family)).toEqual([proxy]);
    expect(published.createStores).not.toHaveBeenCalled();
    expect(replacement.createStores).toHaveBeenCalledOnce();
    expect(runtime.acquire).toHaveBeenCalledOnce();
    expect(runtime.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ config }),
      expect.any(Object),
    );
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it.each(["kimi", "kimi-coding"])(
    "prepares a credential-only %s through its manifest model while another provider is primary",
    async (requested) => {
      const config: OpenClawConfig = { agents: { defaults: { model: "other/test-model" } } };
      runtime.acquire.mockResolvedValue({
        snapshot: snapshot(config, { providers: {} }),
        [Symbol.asyncDispose]: runtime.dispose,
      });
      const controller = new AbortController();
      const resolve = createUsageModelBaseUrlResolver({
        config,
        agentDir: "/test-agent",
        providerIds: [requested],
      });
      expect(await resolve(family, controller.signal)).toEqual([official]);
      expect(runtime.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          config,
          agentDir: "/test-agent",
          skipCredentials: true,
          runtimePluginPurpose: "model-catalog",
          runtimePluginSelections: [{ provider: "kimi", modelId: "test-model" }],
        }),
        { catalogMode: "static", abortSignal: controller.signal },
      );
      expect(runtime.dispose).toHaveBeenCalledOnce();
    },
  );
});
