import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("plugin contract registry partial failures", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../bundled-capability-runtime.js");
    vi.doUnmock("../providers.runtime.js");
    vi.resetModules();
  });

  it("keeps surviving contract registries loaded when one plugin importer fails", async () => {
    vi.doMock("../providers.runtime.js", () => {
      return {
        resolvePluginProviders: (params: { onlyPluginIds?: string[] }) => {
          const pluginId = params.onlyPluginIds?.[0];
          if (pluginId === "xai") {
            throw new Error("xai import failed for test");
          }
          if (pluginId === "openai") {
            return [{ id: "openai", pluginId: "openai" }];
          }
          if (!pluginId) {
            return [];
          }
          return [{ id: `${pluginId}-provider`, pluginId }];
        },
      };
    });

    vi.doMock("../bundled-capability-runtime.js", () => {
      return {
        loadBundledCapabilityRuntimeRegistry: (params: { pluginIds: string[] }) => {
          if (params.pluginIds.includes("xai")) {
            throw new Error("xai import failed for test");
          }
          return {
            webSearchProviders: params.pluginIds.includes("brave")
              ? [
                  {
                    pluginId: "brave",
                    provider: {
                      id: "brave",
                      requiresCredential: true,
                      envVars: ["BRAVE_API_KEY"],
                    },
                  },
                ]
              : [],
          };
        },
      };
    });

    const registry = await import("./registry.js");

    expect(registry.providerContractRegistry.length).toBeGreaterThan(0);
    expect(registry.providerContractRegistry.some((entry) => entry.pluginId === "xai")).toBe(
      false,
    );
    expect(registry.providerContractRegistry.some((entry) => entry.pluginId === "openai")).toBe(
      true,
    );
    expect(
      registry.webSearchProviderContractRegistry.some((entry) => entry.pluginId === "xai"),
    ).toBe(false);
    expect(
      registry.webSearchProviderContractRegistry.some((entry) => entry.pluginId === "brave"),
    ).toBe(true);
    expect(registry.providerContractLoadError).toBeInstanceOf(Error);
    expect(registry.providerContractLoadError?.message).toContain("xai");
    expect(registry.providerContractLoadError?.message).toContain("xai import failed for test");
  });
});
