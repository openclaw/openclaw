import * as embeddingProviderSdk from "openclaw/plugin-sdk/embedding-providers";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";

function embeddingRegistry() {
  const { config, registry } = createPluginRegistryFixture();
  return {
    registry: registry.registry,
    register: (id: string, providerId: string, declared = true) => {
      registerVirtualTestPlugin({
        registry,
        config,
        id,
        name: id,
        ...(declared ? { contracts: { embeddingProviders: [providerId] } } : {}),
        register(api) {
          api.registerEmbeddingProvider({
            id: providerId,
            create: async () => ({ provider: null }),
          });
        },
      });
    },
  };
}

describe("embedding provider registration", () => {
  it("keeps public SDK helpers read-only so plugins cannot bypass manifest ownership", () => {
    for (const name of [
      "registerEmbeddingProvider",
      "listRegisteredEmbeddingProviders",
      "clearEmbeddingProviders",
      "restoreEmbeddingProviders",
      "restoreRegisteredEmbeddingProviders",
    ]) {
      expect(embeddingProviderSdk).not.toHaveProperty(name);
    }
  });

  it("rejects plugins that did not declare the capability contract", () => {
    const { registry, register } = embeddingRegistry();
    register("not-embedding", "forbidden", false);
    expect(registry.embeddingProviders).toStrictEqual([]);
    const diagnostic = registry.diagnostics.find((entry) => entry.pluginId === "not-embedding");
    expect(diagnostic?.message).toBe(
      "plugin must declare contracts.embeddingProviders for adapter: forbidden",
    );
  });

  it("allows plugins that declare the capability contract", () => {
    const { registry, register } = embeddingRegistry();
    register("embedding-owner", "embedding-owner");
    expect(registry.embeddingProviders).toMatchObject([
      { provider: { id: "embedding-owner" }, pluginId: "embedding-owner" },
    ]);
    expect(registry.embeddingProviders).toHaveLength(1);
    expect(registry.plugins[0]?.embeddingProviderIds).toContain("embedding-owner");
  });

  it("rejects duplicate provider ids", () => {
    const { registry, register } = embeddingRegistry();
    for (const id of ["first-owner", "second-owner"]) {
      register(id, "shared");
    }
    expect(registry.embeddingProviders).toHaveLength(1);
    const diagnostic = registry.diagnostics.find((entry) => entry.pluginId === "second-owner");
    expect(diagnostic?.message).toBe(
      "embedding provider already registered: shared (owner: first-owner)",
    );
  });

  it("keeps core embedding provider ids reserved", () => {
    const { registry, register } = embeddingRegistry();
    register("core-shadow", "openai-compatible");
    expect(registry.embeddingProviders).toStrictEqual([]);
    const diagnostic = registry.diagnostics.find((entry) => entry.pluginId === "core-shadow");
    expect(diagnostic?.message).toBe(
      "embedding provider already registered: openai-compatible (owner: core)",
    );
  });
});
