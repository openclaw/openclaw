import { describe, expect, it, vi } from "vitest";
import { createPluginRegistry, type PluginRecord } from "./registry.js";

function createRecord(id: string): PluginRecord {
  return {
    id,
    name: id,
    source: `/tmp/${id}.ts`,
    origin: "workspace",
    enabled: true,
    status: "loaded",
    toolNames: [],
    hookNames: [],
    channelIds: [],
    providerIds: [],
    searchProviderIds: [],
    capabilityIds: [],
    declaredCapabilities: [],
    requiredCapabilities: [],
    conflictingCapabilities: [],
    gatewayMethods: [],
    cliCommands: [],
    services: [],
    commands: [],
    httpRoutes: 0,
    hookCount: 0,
    configSchema: false,
  };
}

describe("search provider registration", () => {
  it("rejects duplicate provider ids case-insensitively and tracks plugin ids", () => {
    const { registry, createApi } = createPluginRegistry({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      runtime: {} as never,
    });

    const firstApi = createApi(createRecord("first-plugin"), { config: {} });
    const secondApi = createApi(createRecord("second-plugin"), { config: {} });

    firstApi.registerSearchProvider({
      id: "Tavily",
      name: "Tavily",
      search: async () => ({ content: "ok" }),
    });
    secondApi.registerSearchProvider({
      id: "tavily",
      name: "Duplicate Tavily",
      search: async () => ({ content: "duplicate" }),
    });

    expect(registry.searchProviders).toHaveLength(1);
    expect(registry.searchProviders[0]?.provider.id).toBe("tavily");
    expect(registry.searchProviders[0]?.provider.pluginId).toBe("first-plugin");
    expect(registry.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "first-plugin",
          kind: "search-provider",
          capability: "providers.search.tavily",
          id: "tavily",
          slot: "providers.search",
          slotMode: "multi",
        }),
      ]),
    );
    expect(registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          pluginId: "second-plugin",
          message: "search provider already registered: tavily (first-plugin)",
        }),
      ]),
    );
  });
});
