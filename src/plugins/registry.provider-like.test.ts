/** Verifies provider-like plugin registry entries across capability families. */
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { registryContainsRuntimePluginIds } from "./active-runtime-registry.js";
import { createPluginRecord } from "./loader-records.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import type {
  OpenClawPluginApi,
  ProviderPluginCatalog,
  UnifiedModelCatalogProviderContext,
} from "./types.js";

describe("plugin registry provider-like registrations", () => {
  it("combines same-plugin overlapping model catalog hooks", async () => {
    const builder = createTestRegistry();
    const { record } = createCatalogOwner(builder, "catalog-owner");
    const rows = ["tts-model", "realtime-model"].map((model) => ({
      kind: "voice" as const,
      provider: "catalog-provider",
      model,
      source: "static" as const,
    }));
    for (const row of rows) {
      builder.registerModelCatalogProvider(record, {
        provider: "catalog-provider",
        kinds: ["voice"],
        staticCatalog: () => [row],
      });
    }
    expect(builder.registry.modelCatalogProviders).toHaveLength(1);
    await expect(
      builder.registry.modelCatalogProviders[0]?.provider.staticCatalog?.(catalogContext),
    ).resolves.toEqual(rows);
  });

  it("does not duplicate manifest-declared provider IDs", () => {
    const builder = createTestRegistry();
    const { record, api } = createCatalogOwner(builder, "owner", {
      contracts: { speechProviders: ["speech"] },
    });
    registerReservedProvider(api, "speech", "speech", async () => null);
    expect(record.speechProviderIds).toEqual(["speech"]);
    expect(builder.registry.speechProviders).toHaveLength(1);
  });
});

const reservationCases = [
  ["text", "providers", "text"],
  ["speech", "speechProviders", "voice"],
  ["transcription", "realtimeTranscriptionProviders", "voice"],
  ["realtime", "realtimeVoiceProviders", "voice"],
  ["image", "imageGenerationProviders", "image_generation"],
  ["video", "videoGenerationProviders", "video_generation"],
  ["music", "musicGenerationProviders", "music_generation"],
] as const;

function registerReservedProvider(
  api: OpenClawPluginApi,
  family: (typeof reservationCases)[number][0],
  id: string,
  run: ProviderPluginCatalog["run"],
) {
  const provider = { id, label: "Catalog provider", defaultModel: "default", models: ["default"] };
  const unused = () => {
    throw new Error("registration must not invoke provider operations");
  };
  switch (family) {
    case "text":
      return api.registerProvider({
        ...provider,
        auth: [],
        catalog: { run },
        staticCatalog: { run },
      });
    case "speech":
      return api.registerSpeechProvider({ ...provider, isConfigured: unused, synthesize: unused });
    case "transcription":
      return api.registerRealtimeTranscriptionProvider({
        ...provider,
        isConfigured: unused,
        createSession: unused,
      });
    case "realtime":
      return api.registerRealtimeVoiceProvider({
        ...provider,
        isConfigured: unused,
        createBridge: unused,
      });
    case "image":
      return api.registerImageGenerationProvider({
        ...provider,
        capabilities: { generate: { maxCount: 1 }, edit: { enabled: false } },
        generateImage: unused,
      });
    case "video":
      return api.registerVideoGenerationProvider({
        ...provider,
        capabilities: { generate: { maxDurationSeconds: 4 } },
        generateVideo: unused,
      });
    case "music":
      return api.registerMusicGenerationProvider({
        ...provider,
        capabilities: { generate: { maxTracks: 1 } },
        generateMusic: unused,
      });
  }
}

function createCatalogOwner(
  builder: ReturnType<typeof createTestRegistry>,
  id: string,
  fields: Partial<Parameters<typeof createPluginRecord>[0]> = {},
) {
  const record = createPluginRecord({
    id,
    name: id,
    source: `/plugins/${id}/index.ts`,
    origin: "global",
    enabled: true,
    configSchema: false,
    ...fields,
  });
  return { record, api: builder.createApi(record, { config: {} }) };
}

function catalogOwners(builder: ReturnType<typeof createTestRegistry>) {
  return builder.registry.modelCatalogProviders.map(({ pluginId, provider }) => ({
    pluginId,
    provider: provider.provider,
    kinds: provider.kinds,
  }));
}

const catalogContext: UnifiedModelCatalogProviderContext = {
  config: {},
  env: {},
  resolveProviderApiKey: () => ({ apiKey: undefined }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

describe("text catalog ownership", () => {
  it("rejects blank provider IDs without executing catalog hooks", () => {
    const builder = createTestRegistry();
    const { api, record } = createCatalogOwner(builder, "owner");
    const run = vi.fn(async () => null);
    expect(registerReservedProvider(api, "text", "   ", run)).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
    expect(builder.registry.providers).toEqual([]);
    expect(record.providerIds).toEqual([]);
    expect(catalogOwners(builder)).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: "owner",
        source: record.source,
        message: "provider registration missing id",
      },
    ]);
  });
});

describe("text catalog composition", () => {
  const family = "text";
  const kind = "text";
  it("preserves foreign catalog ownership while accepting the provider registration", () => {
    const builder = createTestRegistry();
    const alpha = createCatalogOwner(builder, "alpha");
    const beta = createCatalogOwner(builder, "beta");
    const run = vi.fn(async () => null);
    alpha.api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: ["text"] });
    registerReservedProvider(beta.api, family, "catalog-provider", run);
    expect(catalogOwners(builder)).toEqual([
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["text"] },
    ]);
    expect(builder.registry.providers.map(({ pluginId }) => pluginId)).toEqual(["beta"]);
    expect(builder.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: "beta",
        source: beta.record.source,
        message: "model catalog provider already registered: catalog-provider (alpha)",
      },
    ]);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["automatic-first", "explicit-first"] as const)(
    "retains explicit static/live contributions alongside a same-plugin reservation (%s)",
    async (order) => {
      const builder = createTestRegistry();
      const { api } = createCatalogOwner(builder, "owner");
      const run = vi.fn(async () => null);
      const row = { kind, provider: "catalog-provider", model: "explicit-model" } as const;
      const staticCatalog = vi.fn(() => [{ ...row, source: "static" as const }]);
      const liveCatalog = vi.fn(() => [{ ...row, source: "live" as const }]);
      const automatic = () => registerReservedProvider(api, family, "catalog-provider", run);
      const explicit = () =>
        api.registerModelCatalogProvider({
          provider: "catalog-provider",
          kinds: [kind],
          staticCatalog,
          liveCatalog,
        });
      if (order === "automatic-first") {
        automatic();
        explicit();
      } else {
        explicit();
        automatic();
      }
      expect(catalogOwners(builder)).toEqual([
        { pluginId: "owner", provider: "catalog-provider", kinds: [kind] },
      ]);
      expect(run).not.toHaveBeenCalled();
      expect(staticCatalog).not.toHaveBeenCalled();
      expect(liveCatalog).not.toHaveBeenCalled();
      const provider = expectDefined(
        builder.registry.modelCatalogProviders[0],
        "catalog reservation",
      ).provider;
      const staticRows = await provider.staticCatalog?.(catalogContext);
      const liveRows = await provider.liveCatalog?.(catalogContext);
      // Automatic rows are intentionally not an oracle; the explicit API contribution is.
      expect(staticRows?.filter((entry) => entry.model === row.model)).toEqual([
        { ...row, source: "static" },
      ]);
      expect(liveRows?.filter((entry) => entry.model === row.model)).toEqual([
        { ...row, source: "live" },
      ]);
      expect(staticCatalog).toHaveBeenCalledExactlyOnceWith(catalogContext);
      expect(liveCatalog).toHaveBeenCalledExactlyOnceWith(catalogContext);
      expect(builder.registry.diagnostics).toEqual([]);
    },
  );
});

describe("catalog reservation lifecycle", () => {
  it("reserves each capability's catalog kind through its public registrar", () => {
    for (const [family, registryKey, kind] of reservationCases) {
      const builder = createTestRegistry();
      const { api } = createCatalogOwner(builder, "owner");
      registerReservedProvider(api, family, "catalog-provider", async () => null);

      expect(builder.registry[registryKey]).toMatchObject([
        { pluginId: "owner", provider: { id: "catalog-provider" } },
      ]);
      expect(catalogOwners(builder)).toEqual([
        { pluginId: "owner", provider: "catalog-provider", kinds: [kind] },
      ]);
    }
  });

  it.each(["none", "static", "live"] as const)("reserves text only when eligible (%s)", (mode) => {
    const builder = createTestRegistry();
    const { api } = createCatalogOwner(builder, "owner");
    const run = vi.fn(async () => null);
    api.registerProvider({
      id: "text-provider",
      label: "Text provider",
      auth: [],
      ...(mode === "live" ? { catalog: { run } } : {}),
      ...(mode === "static" ? { staticCatalog: { run } } : {}),
    });
    expect(builder.registry.providers).toHaveLength(1);
    expect(catalogOwners(builder)).toEqual(
      mode === "none" ? [] : [{ pluginId: "owner", provider: "text-provider", kinds: ["text"] }],
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the first overlapping row, distinct kinds, rollback, and record-authoritative containment", () => {
    const builder = createTestRegistry();
    const alpha = createCatalogOwner(builder, "alpha");
    const beta = createCatalogOwner(builder, "beta");
    const run = vi.fn(async () => null);
    for (const [family] of reservationCases) {
      registerReservedProvider(alpha.api, family, "catalog-provider", run);
    }
    beta.api.registerModelCatalogProvider({ provider: "other-provider", kinds: ["voice"] });
    const explicit = vi.fn(() => []);
    alpha.api.registerModelCatalogProvider({
      provider: "catalog-provider",
      kinds: ["voice", "text", "voice"],
      staticCatalog: explicit,
    });
    expect(catalogOwners(builder)).toEqual([
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["text", "voice"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["voice"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["image_generation"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["video_generation"] },
      { pluginId: "alpha", provider: "catalog-provider", kinds: ["music_generation"] },
      { pluginId: "beta", provider: "other-provider", kinds: ["voice"] },
    ]);
    expect(registryContainsRuntimePluginIds(builder.registry, ["alpha", "beta"])).toBe(true);
    expect(registryContainsRuntimePluginIds(builder.registry, [])).toBe(false);
    builder.registry.plugins.push({ ...alpha.record, status: "disabled" });
    expect(registryContainsRuntimePluginIds(builder.registry, ["alpha"])).toBe(false);
    builder.registry.plugins.pop();
    builder.rollbackPluginGlobalSideEffects(alpha.record.id, alpha.record);
    expect(catalogOwners(builder)).toEqual([
      { pluginId: "beta", provider: "other-provider", kinds: ["voice"] },
    ]);
    for (const [, registryKey] of reservationCases) {
      expect(builder.registry[registryKey]).toEqual([]);
    }
    expect(registryContainsRuntimePluginIds(builder.registry, ["alpha"])).toBe(false);
    expect(registryContainsRuntimePluginIds(builder.registry, ["beta"])).toBe(true);
    expect(builder.registry.diagnostics).toEqual([]);
    expect(run).not.toHaveBeenCalled();
    expect(explicit).not.toHaveBeenCalled();
  });

  it("rejects missing explicit provider and kinds without claiming ownership", () => {
    const builder = createTestRegistry();
    const { api, record } = createCatalogOwner(builder, "owner");
    api.registerModelCatalogProvider({ provider: " ", kinds: ["text"] });
    api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: [] });
    expect(catalogOwners(builder)).toEqual([]);
    expect(builder.registry.diagnostics).toEqual([
      {
        level: "error",
        pluginId: "owner",
        source: record.source,
        message: "model catalog provider registration missing provider",
      },
      {
        level: "error",
        pluginId: "owner",
        source: record.source,
        message: 'model catalog provider "catalog-provider" registration missing kinds',
      },
    ]);
  });
});
