import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { registryContainsRuntimePluginIds } from "./active-runtime-registry.js";
import { createOwnershipRecord } from "./registry-ownership.test-support.js";
import { createTestPluginRegistry as createTestRegistry } from "./registry-runtime.test-helpers.js";
import type {
  OpenClawPluginApi,
  ProviderPluginCatalog,
  UnifiedModelCatalogProviderContext,
} from "./types.js";

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

const reservationCases = [
  ["text", "providers"],
  ["speech", "speechProviders"],
  ["transcription", "realtimeTranscriptionProviders"],
  ["realtime", "realtimeVoiceProviders"],
  ["image", "imageGenerationProviders"],
  ["video", "videoGenerationProviders"],
  ["music", "musicGenerationProviders"],
] as const;

function registerReservedProvider(
  api: OpenClawPluginApi,
  family: (typeof reservationCases)[number][0] | "media",
  id: string,
  run: ProviderPluginCatalog["run"],
) {
  const provider = { id, label: "Catalog provider", defaultModel: "default", models: ["default"] };
  const unused = () => {
    throw new Error("registration must not invoke provider operations");
  };
  const voice = { ...provider, isConfigured: unused };
  switch (family) {
    case "text":
      return api.registerProvider({
        ...provider,
        auth: [],
        catalog: { run },
        staticCatalog: { run },
      });
    case "media":
      return api.registerMediaUnderstandingProvider({ id, capabilities: ["image"] });
    case "speech":
      return api.registerSpeechProvider({ ...voice, synthesize: unused });
    case "transcription":
      return api.registerRealtimeTranscriptionProvider({ ...voice, createSession: unused });
    case "realtime":
      return api.registerRealtimeVoiceProvider({ ...voice, createBridge: unused });
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

function createCatalogOwner(builder: ReturnType<typeof createTestRegistry>, id: string) {
  const record = createOwnershipRecord(id, { source: `/plugins/${id}/index.ts` });
  return { record, api: builder.createApi(record, { config: {} }) };
}

function catalogOwners(builder: ReturnType<typeof createTestRegistry>) {
  return builder.registry.modelCatalogProviders.map(({ pluginId, provider }) => [
    pluginId,
    provider.provider,
    provider.kinds,
  ]);
}

function registrationErrors(record: { id: string; source: string }, ...messages: string[]) {
  const { id: pluginId, source } = record;
  return messages.map((message) => ({ level: "error", pluginId, source, message }));
}

const catalogContext: UnifiedModelCatalogProviderContext = {
  config: {},
  env: {},
  resolveProviderApiKey: () => ({ apiKey: undefined }),
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
};

it.each([
  ["speech", "speechProviders", "speech provider already registered: shared (first)"],
  ["media", "mediaUnderstandingProviders", "media provider already registered: shared (first)"],
] as const)("rejects padded duplicate %s provider IDs", (family, registryKey, diagnostic) => {
  const builder = createTestRegistry();
  const first = createCatalogOwner(builder, "first");
  const second = createCatalogOwner(builder, "second");
  const catalog = async () => null;
  registerReservedProvider(first.api, family, " shared ", catalog);
  expect(builder.registry[registryKey]).toHaveLength(1);
  expect(builder.registry.diagnostics).toEqual([]);

  registerReservedProvider(second.api, family, "shared", catalog);
  expect(
    builder.registry[registryKey].map(({ pluginId, provider }) => [pluginId, provider.id]),
  ).toEqual([["first", " shared "]]);
  expect(builder.registry.diagnostics).toEqual(registrationErrors(second.record, diagnostic));
});

it("rejects blank text provider IDs without executing catalog hooks", () => {
  const builder = createTestRegistry();
  const { api, record } = createCatalogOwner(builder, "owner");
  const run = vi.fn(async () => null);
  expect(registerReservedProvider(api, "text", "   ", run)).toBeUndefined();
  expect(run).not.toHaveBeenCalled();
  expect(builder.registry.providers).toEqual([]);
  expect(record.providerIds).toEqual([]);
  expect(catalogOwners(builder)).toEqual([]);
  expect(builder.registry.diagnostics).toEqual(
    registrationErrors(record, "provider registration missing id"),
  );
});

describe("text catalog composition", () => {
  it("preserves foreign catalog ownership while accepting the provider registration", () => {
    const builder = createTestRegistry();
    const alpha = createCatalogOwner(builder, "alpha");
    const beta = createCatalogOwner(builder, "beta");
    const run = vi.fn(async () => null);
    alpha.api.registerModelCatalogProvider({ provider: "catalog-provider", kinds: ["text"] });
    registerReservedProvider(beta.api, "text", "catalog-provider", run);
    expect(catalogOwners(builder)).toEqual([["alpha", "catalog-provider", ["text"]]]);
    expect(builder.registry.providers.map(({ pluginId }) => pluginId)).toEqual(["beta"]);
    expect(builder.registry.diagnostics).toEqual(
      registrationErrors(
        beta.record,
        "model catalog provider already registered: catalog-provider (alpha)",
      ),
    );
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["automatic-first", "explicit-first"] as const)(
    "retains explicit static/live contributions alongside a same-plugin reservation (%s)",
    async (order) => {
      const builder = createTestRegistry();
      const { api } = createCatalogOwner(builder, "owner");
      const run = vi.fn(async () => null);
      const row = { kind: "text", provider: "catalog-provider", model: "explicit-model" } as const;
      const staticCatalog = vi.fn(() => [{ ...row, source: "static" as const }]);
      const liveCatalog = vi.fn(() => [{ ...row, source: "live" as const }]);
      const automatic = () => registerReservedProvider(api, "text", "catalog-provider", run);
      const explicit = () =>
        api.registerModelCatalogProvider({
          provider: "catalog-provider",
          kinds: ["text"],
          staticCatalog,
          liveCatalog,
        });
      for (const register of order === "automatic-first"
        ? [automatic, explicit]
        : [explicit, automatic]) {
        register();
      }
      expect(catalogOwners(builder)).toEqual([["owner", "catalog-provider", ["text"]]]);
      expect(run).not.toHaveBeenCalled();
      expect(staticCatalog).not.toHaveBeenCalled();
      expect(liveCatalog).not.toHaveBeenCalled();
      const provider = expectDefined(
        builder.registry.modelCatalogProviders[0],
        "catalog reservation",
      ).provider;
      // Automatic rows are intentionally not an oracle; the explicit API contribution is.
      for (const [source, rows, hook] of [
        ["static", await provider.staticCatalog?.(catalogContext), staticCatalog],
        ["live", await provider.liveCatalog?.(catalogContext), liveCatalog],
      ] as const) {
        expect(rows?.filter((entry) => entry.model === row.model)).toEqual([{ ...row, source }]);
        expect(hook).toHaveBeenCalledExactlyOnceWith(catalogContext);
      }
      expect(builder.registry.diagnostics).toEqual([]);
    },
  );
});

describe("catalog reservation lifecycle", () => {
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
      mode === "none" ? [] : [["owner", "text-provider", ["text"]]],
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("keeps the first overlapping row, distinct kinds, rollback, and record-authoritative containment", () => {
    const builder = createTestRegistry();
    const alpha = createCatalogOwner(builder, "alpha");
    const beta = createCatalogOwner(builder, "beta");
    const run = vi.fn(async () => null);
    for (const [family, registryKey] of reservationCases) {
      registerReservedProvider(alpha.api, family, "catalog-provider", run);
      expect(builder.registry[registryKey]).toMatchObject([
        { pluginId: "alpha", provider: { id: "catalog-provider" } },
      ]);
    }
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
    expect(builder.registry.diagnostics).toEqual(
      registrationErrors(
        record,
        "model catalog provider registration missing provider",
        'model catalog provider "catalog-provider" registration missing kinds',
      ),
    );
  });
});
