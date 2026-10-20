import { describe, expect, it, vi } from "vitest";
import { resolveRequesterScopedMcpConnections } from "../agents/mcp-connection-resolver.js";
import { createPluginRegistry } from "./registry.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createRegistryHarness(allowProcessHomeSessionCatalogs = true) {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    allowProcessHomeSessionCatalogs,
    activateGlobalSideEffects: false,
  });
  const apiFor = (id: string) => {
    const record = createPluginRecord({ id, source: `/plugins/${id}/index.ts` });
    pluginRegistry.registry.plugins.push(record);
    return pluginRegistry.createApi(record, { config: {} });
  };
  const resolve = () =>
    withPluginRuntimeRegistryScope(pluginRegistry.registry, () =>
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail"],
        requesterSenderId: "sender",
      }),
    );
  return { registry: pluginRegistry.registry, apiFor, resolve };
}

const createCatalog = (): SessionCatalogProvider => ({
  id: "catalog",
  label: "Catalog",
  list: async () => [],
  read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
});

describe("registerMcpServerConnectionResolver ownership", () => {
  it("rejects a duplicate serverName from another plugin with an error diagnostic", async () => {
    const { registry, apiFor, resolve } = createRegistryHarness();
    const firstResolve = vi.fn(async () => ({ url: "https://mcp.example.test/owner" }));
    const rejectedResolve = vi.fn(async () => ({ url: "https://mcp.example.test/hijack" }));
    apiFor("plugin-a").registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: firstResolve,
    });
    apiFor("plugin-b").registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: rejectedResolve,
    });

    expect(registry.mcpServerConnectionResolvers).toHaveLength(1);
    expect(registry.mcpServerConnectionResolvers[0]).toMatchObject({
      pluginId: "plugin-a",
      resolver: { serverName: "user-mail" },
    });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "plugin-b",
        message: expect.stringContaining('already registered by plugin "plugin-a"'),
      }),
    );
    await expect(resolve()).resolves.toEqual(
      new Map([["user-mail", { url: "https://mcp.example.test/owner" }]]),
    );
    expect(firstResolve).toHaveBeenCalledOnce();
    expect(rejectedResolve).not.toHaveBeenCalled();
  });

  it("lets the owning plugin replace its own resolver", async () => {
    const { registry, apiFor, resolve } = createRegistryHarness();
    const api = apiFor("plugin-a");
    const original = vi.fn(async () => ({ url: "https://mcp.example.test/original" }));
    const replacement = vi.fn(async () => ({ url: "https://mcp.example.test/replacement" }));
    api.registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: original,
    });
    api.registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: replacement,
    });

    expect(registry.mcpServerConnectionResolvers).toHaveLength(1);
    expect(registry.diagnostics.filter(({ level }) => level === "error")).toEqual([]);
    await expect(resolve()).resolves.toEqual(
      new Map([["user-mail", { url: "https://mcp.example.test/replacement" }]]),
    );
    expect(replacement).toHaveBeenCalledOnce();
    expect(original).not.toHaveBeenCalled();
  });
});

describe("registerSessionCatalog ownership", () => {
  it("keeps isolation-aware providers when process-HOME catalogs are disabled", () => {
    const { registry, apiFor } = createRegistryHarness(false);
    apiFor("catalog").registerSessionCatalog({
      ...createCatalog(),
      supportsProcessHomeIsolation: true,
    });

    expect(registry.sessionCatalogs).toHaveLength(1);
  });

  it("suppresses legacy providers only when process-HOME catalogs are disabled", () => {
    const isolated = createRegistryHarness(false);
    const catalog = createCatalog();
    isolated.apiFor("legacy").registerSessionCatalog(catalog);
    expect(isolated.registry.sessionCatalogs).toEqual([]);
    expect(isolated.registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("supportsProcessHomeIsolation"),
      }),
    );

    const defaultIdentity = createRegistryHarness();
    defaultIdentity.apiFor("legacy").registerSessionCatalog(catalog);
    expect(defaultIdentity.registry.sessionCatalogs).toHaveLength(1);
  });
});
