import { describe, expect, it, vi } from "vitest";
import { resolveRequesterScopedMcpConnections } from "../agents/mcp-connection-resolver.js";
import { expectDiagnostic } from "./registry-registration.test-support.js";
import { createPluginRegistry } from "./registry.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import type { SessionCatalogProvider } from "./session-catalog.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function fixture(allowProcessHomeSessionCatalogs = true) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    allowProcessHomeSessionCatalogs,
    activateGlobalSideEffects: false,
  });
  const apiFor = (id: string) => {
    const record = createPluginRecord({ id, source: `/plugins/${id}/index.ts` });
    builder.registry.plugins.push(record);
    return builder.createApi(record, { config: {} });
  };
  const resolve = () =>
    withPluginRuntimeRegistryScope(builder.registry, () =>
      resolveRequesterScopedMcpConnections({
        serverNames: ["user-mail"],
        requesterSenderId: "sender",
      }),
    );
  return { registry: builder.registry, apiFor, resolve };
}
const createCatalog = (): SessionCatalogProvider => ({
  id: "catalog",
  label: "Catalog",
  list: async () => [],
  read: async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }),
});

describe("MCP resolver ownership", () => {
  it.each([false, true])("allows replacement only by the owner: %s", async (sameOwner) => {
    const { registry, apiFor, resolve } = fixture();
    const first = vi.fn(async () => ({ url: "https://mcp.example.test/owner" }));
    const next = vi.fn(async () => ({ url: "https://mcp.example.test/replacement" }));
    const api = apiFor("plugin-a");
    api.registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: first,
    });
    (sameOwner ? api : apiFor("plugin-b")).registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: next,
    });
    expect(registry.mcpServerConnectionResolvers).toMatchObject([
      { pluginId: "plugin-a", resolver: { serverName: "user-mail" } },
    ]);
    if (sameOwner) {
      expect(registry.diagnostics.filter(({ level }) => level === "error")).toEqual([]);
    } else {
      expectDiagnostic(registry, {
        level: "error",
        pluginId: "plugin-b",
        message: expect.stringContaining('already registered by plugin "plugin-a"'),
      });
    }
    await expect(resolve()).resolves.toEqual(
      new Map([
        [
          "user-mail",
          {
            url: `https://mcp.example.test/${sameOwner ? "replacement" : "owner"}`,
          },
        ],
      ]),
    );
    expect(first).toHaveBeenCalledTimes(sameOwner ? 0 : 1);
    expect(next).toHaveBeenCalledTimes(sameOwner ? 1 : 0);
  });
});

describe("session catalog isolation", () => {
  it("keeps isolation-aware providers when process-HOME catalogs are disabled", () => {
    const { registry, apiFor } = fixture(false);
    apiFor("catalog").registerSessionCatalog({
      ...createCatalog(),
      supportsProcessHomeIsolation: true,
    });
    expect(registry.sessionCatalogs).toHaveLength(1);
  });

  it("suppresses legacy providers only when process-HOME catalogs are disabled", () => {
    const isolated = fixture(false);
    const catalog = createCatalog();
    isolated.apiFor("legacy").registerSessionCatalog(catalog);
    expect(isolated.registry.sessionCatalogs).toEqual([]);
    expectDiagnostic(isolated.registry, {
      level: "warn",
      message: expect.stringContaining("supportsProcessHomeIsolation"),
    });
    const defaultIdentity = fixture();
    defaultIdentity.apiFor("legacy").registerSessionCatalog(catalog);
    expect(defaultIdentity.registry.sessionCatalogs).toHaveLength(1);
  });
});
