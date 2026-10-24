import { beforeEach, expect, it } from "vitest";
import { collectRegisteredEmbeddingProviderIds } from "./channel-plugin-ids.js";
import { CORE_EMBEDDING_PROVIDERS } from "./core-embedding-providers.js";
import {
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  registerEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  type EmbeddingProviderAdapter,
} from "./embedding-providers.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
  withPluginRegistrationContext,
} from "./runtime.js";

function createAdapter(id: string): EmbeddingProviderAdapter {
  return { id, create: async () => ({ provider: null }) };
}

beforeEach(({ onTestFinished }) => {
  const previous = captureActivePluginRegistrySnapshot();
  onTestFinished(() => {
    rollbackStagedPluginRegistry(previous);
  });
  stageActivePluginRegistry(createEmptyPluginRegistry(), null, "default");
});

it("preserves owner metadata in registered snapshots", () => {
  const adapter = createAdapter("local-compatible");
  const entry = { adapter, ownerPluginId: "local-compatible" };

  restoreRegisteredEmbeddingProviders([entry]);

  expect(getRegisteredEmbeddingProvider("local-compatible")).toEqual(entry);
  expect(listRegisteredEmbeddingProviders()).toEqual([...CORE_EMBEDDING_PROVIDERS, entry]);
});

it.each(CORE_EMBEDDING_PROVIDERS)(
  "keeps core provider $adapter.id from being shadowed by restored snapshots",
  (coreEntry) => {
    const adapter = createAdapter(coreEntry.adapter.id);

    expect(() =>
      restoreRegisteredEmbeddingProviders([{ adapter, ownerPluginId: "shadow" }]),
    ).toThrow(`embedding provider already registered: ${adapter.id} (owner: core)`);

    expect(getRegisteredEmbeddingProvider(adapter.id)).toBe(coreEntry);
  },
);

it("uses builder ownership without displacing another plugin's adapter", () => {
  const building = createEmptyPluginRegistry();
  const original = createAdapter("shared");
  building.embeddingProviders.push({
    pluginId: "first-plugin",
    provider: original,
    source: "runtime",
  });

  expect(() =>
    withPluginRegistrationContext(building, "failing-plugin", () => {
      registerEmbeddingProvider(createAdapter("shared"));
    }),
  ).toThrow("embedding provider shared already registered by first-plugin");
  expect(building.embeddingProviders[0]?.provider).toBe(original);

  withPluginRegistrationContext(building, "builder-plugin", () => {
    registerEmbeddingProvider(createAdapter("owned"));
  });
  expect(building.embeddingProviders[1]?.pluginId).toBe("builder-plugin");
});

// /status and the boot warning must agree on registered providers.
it("unions registry embedding providers with the global registry", () => {
  const adapter = createAdapter("global-embed");
  registerEmbeddingProvider(adapter, { ownerPluginId: "p" });
  const ids = collectRegisteredEmbeddingProviderIds({
    embeddingProviders: [{ provider: { id: "gen-embed" } }],
  } as never);

  expect(getRegisteredEmbeddingProvider("global-embed")).toEqual({ adapter, ownerPluginId: "p" });
  expect(ids).toEqual(new Set(["gen-embed", "global-embed", ...registeredIds()]));
});

it("returns only the global registry ids when the runtime registry omits embedding providers", () => {
  expect(collectRegisteredEmbeddingProviderIds({})).toEqual(new Set(registeredIds()));
});

function registeredIds() {
  return listRegisteredEmbeddingProviders().map((entry) => entry.adapter.id);
}
