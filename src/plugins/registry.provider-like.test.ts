import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { registryContainsRuntimePluginIds } from "./active-runtime-registry.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import type {
  OpenClawPluginApi,
  ProviderPluginCatalog,
  UnifiedModelCatalogProviderContext,
} from "./types.js";

function registerTextProvider(
  api: OpenClawPluginApi,
  id: string,
  run: ProviderPluginCatalog["run"],
) {
  return api.registerProvider({
    id,
    label: "Catalog provider",
    defaultModel: "default",
    models: ["default"],
    auth: [],
    catalog: { run },
    staticCatalog: { run },
  });
}

function createCatalogOwner(builder = createTestRegistry(), id = "owner") {
  const record = createOwnershipRecord(id, { source: `/plugins/${id}/index.ts` });
  return {
    builder,
    record,
    api: builder.createApi(record, { config: {} }),
    run: vi.fn(async () => null),
    expectErrors: (...messages: string[]) =>
      expect(builder.registry.diagnostics.map(({ message }) => message)).toEqual(messages),
  };
}

function catalogOwners(builder: ReturnType<typeof createTestRegistry>) {
  return builder.registry.modelCatalogProviders.map(({ pluginId, provider }) => [
    pluginId,
    provider.provider,
    provider.kinds,
  ]);
}

const catalogContext: UnifiedModelCatalogProviderContext = {
  config: {},
  env: {},
  resolveProviderApiKey: () => ({ apiKey: undefined }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

it("rejects blank text provider IDs without executing catalog hooks", () => {
  const { builder, api, record, run, expectErrors } = createCatalogOwner();
  expect(registerTextProvider(api, "   ", run)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  expect(builder.registry.providers).toEqual([]);
  expect(record.providerIds).toEqual([]);
  expect(catalogOwners(builder)).toEqual([]);
  expectErrors("provider registration missing id");
});

it("preserves foreign catalog ownership while accepting the provider registration", () => {
  const builder = createTestRegistry();
  const alpha = createCatalogOwner(builder, "alpha");
  const beta = createCatalogOwner(builder, "beta");
  const run = vi.fn(async () => null);
  alpha.api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: ["text"] });
  registerTextProvider(beta.api, "catalog-provider", run);
  expect(catalogOwners(builder)).toEqual([["alpha", "catalog-provider", ["text"]]]);
  expect(builder.registry.providers.map(({ pluginId }) => pluginId)).toEqual(["beta"]);
  beta.expectErrors("model catalog provider already registered: catalog-provider (alpha)");
  expect(run).not.toHaveBeenCalled();
});

it.each(["automatic-first", "explicit-first"] as const)(
  "retains explicit static/live contributions alongside a same-plugin reservation (%s)",
  async (order) => {
    const { builder, api, run, expectErrors } = createCatalogOwner();
    const rows = ["first-model", "second-model"].map((model) => ({
      kind: "text" as const,
      provider: "catalog-provider",
      model,
    }));
    const contributions = rows.map((row) => ({
      staticCatalog: vi.fn(() => [{ ...row, source: "static" as const }]),
      liveCatalog: vi.fn(() => [{ ...row, source: "live" as const }]),
    }));
    const automatic = () => registerTextProvider(api, "catalog-provider", run);
    const explicit = () => {
      for (const hooks of contributions) {
        api.registerModelCatalogProvider({
          provider: "catalog-provider",
          kinds: ["text"],
          ...hooks,
        });
      }
    };
    for (const register of order === "automatic-first"
      ? [automatic, explicit]
      : [explicit, automatic]) {
      register();
    }
    expect(catalogOwners(builder)).toEqual([["owner", "catalog-provider", ["text"]]]);
    for (const hook of [run, ...contributions.flatMap(Object.values)]) {
      expect(hook).not.toHaveBeenCalled();
    }
    const catalog = expectDefined(
      builder.registry.modelCatalogProviders[0],
      "catalog reservation",
    ).provider;
    for (const [source, actual] of [
      ["static", await catalog.staticCatalog?.(catalogContext)],
      ["live", await catalog.liveCatalog?.(catalogContext)],
    ] as const) {
      expect(actual).toEqual(
        rows.map(({ kind, provider, model }) => ({ kind, provider, model, source })),
      );
    }
    expectErrors();
  },
);
it.each(["none", "static", "live"] as const)("reserves text only when eligible (%s)", (mode) => {
  const { builder, api, run } = createCatalogOwner();
  api.registerProvider({
    id: "text-provider",
    label: "Text provider",
    auth: [],
    ...(mode === "live" ? { catalog: { run } } : {}),
    ...(mode === "static" ? { staticCatalog: { run } } : {}),
  });
  expect(builder.registry.providers).toHaveLength(1);
  expect(catalogOwners(builder)).toEqual(
    mode === "none" ? [] : [["owner", "text-provider", ["text"]]],
  );
  expect(run).not.toHaveBeenCalled();
});

it("keeps the first overlapping row, distinct kinds, and authoritative containment through rollback", () => {
  const builder = createTestRegistry();
  const alpha = createCatalogOwner(builder, "alpha");
  const beta = createCatalogOwner(builder, "beta");
  const run = vi.fn(async () => null);
  const unused = () => {
    throw new Error("registration must not invoke provider operations");
  };
  const provider = { id: "catalog-provider", label: "Catalog provider", isConfigured: unused };
  registerTextProvider(alpha.api, provider.id, run);
  alpha.api.registerSpeechProvider({ ...provider, synthesize: unused });
  alpha.api.registerRealtimeTranscriptionProvider({ ...provider, createSession: unused });
  alpha.api.registerRealtimeVoiceProvider({ ...provider, createBridge: unused });
  alpha.api.registerImageGenerationProvider({
    id: provider.id,
    capabilities: { generate: {}, edit: { enabled: false } },
    generateImage: unused,
  });
  alpha.api.registerVideoGenerationProvider({
    id: provider.id,
    capabilities: {},
    generateVideo: unused,
  });
  alpha.api.registerMusicGenerationProvider({
    id: provider.id,
    capabilities: {},
    generateMusic: unused,
  });
  beta.api.registerModelCatalogProvider({ provider: "other-provider", kinds: ["voice"] });
  const explicit = vi.fn(() => []);
  alpha.api.registerModelCatalogProvider({
    provider: "catalog-provider",
    kinds: ["voice", "text", "voice"],
    staticCatalog: explicit,
  });
  expect(catalogOwners(builder)).toEqual([
    ["alpha", "catalog-provider", ["text", "voice"]],
    ["alpha", "catalog-provider", ["voice"]],
    ["alpha", "catalog-provider", ["image_generation"]],
    ["alpha", "catalog-provider", ["video_generation"]],
    ["alpha", "catalog-provider", ["music_generation"]],
    ["beta", "other-provider", ["voice"]],
  ]);
  expect(registryContainsRuntimePluginIds(builder.registry, ["alpha", "beta"])).toBe(true);
  expect(registryContainsRuntimePluginIds(builder.registry, [])).toBe(false);
  builder.registry.plugins.push({ ...alpha.record, status: "disabled" });
  expect(registryContainsRuntimePluginIds(builder.registry, ["alpha"])).toBe(false);
  builder.registry.plugins.pop();
  builder.rollbackPluginGlobalSideEffects(alpha.record.id, alpha.record);
  expect(catalogOwners(builder)).toEqual([["beta", "other-provider", ["voice"]]]);
  expect(registryContainsRuntimePluginIds(builder.registry, ["alpha"])).toBe(false);
  expect(registryContainsRuntimePluginIds(builder.registry, ["beta"])).toBe(true);
  expect(builder.registry.diagnostics).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  expect(explicit).not.toHaveBeenCalled();
});

it("rejects missing explicit provider and kinds without claiming ownership", () => {
  const { builder, api, expectErrors } = createCatalogOwner();
  api.registerModelCatalogProvider({ provider: " ", kinds: ["text"] });
  api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: [] });
  expect(catalogOwners(builder)).toEqual([]);
  expectErrors(
    "model catalog provider registration missing provider",
    'model catalog provider "catalog-provider" registration missing kinds',
  );
});
