/** Verifies that MCP connection and request header registrations share one owner. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createRegistryHarness() {
  const pluginRegistry = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: false,
  });
  const apiFor = (id: string) => {
    const record = createPluginRecord({ id, source: `/plugins/${id}/index.ts` });
    pluginRegistry.registry.plugins.push(record);
    return pluginRegistry.createApi(record, { config: {} as OpenClawConfig });
  };
  return { registry: pluginRegistry.registry, apiFor };
}

describe("registerMcpServerRequestHeaderProvider ownership", () => {
  it("keeps the first plugin's provider and rejects another plugin", async () => {
    const { registry, apiFor } = createRegistryHarness();
    const resolve = vi.fn(() => ({ traceparent: "owner-trace" }));
    apiFor("plugin-a").registerMcpServerRequestHeaderProvider({
      serverName: " user-mail ",
      resolve,
    });
    apiFor("plugin-b").registerMcpServerRequestHeaderProvider({
      serverName: "user-mail",
      resolve: () => ({ traceparent: "other-trace" }),
    });

    expect(registry.mcpServerRequestHeaderProviders).toMatchObject([
      { pluginId: "plugin-a", provider: { serverName: "user-mail" } },
    ]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        pluginId: "plugin-b",
        message: expect.stringContaining('already registered by plugin "plugin-a"'),
      }),
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(
      await registry.mcpServerRequestHeaderProviders[0]?.provider.resolve({
        sessionId: "session",
        runId: "run",
      }),
    ).toEqual({ traceparent: "owner-trace" });
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("lets the owner replace its provider and register its connection resolver", async () => {
    const { registry, apiFor } = createRegistryHarness();
    const api = apiFor("plugin-a");
    const replacement = () => ({ traceparent: "replacement-trace" });
    api.registerMcpServerRequestHeaderProvider({ serverName: "user-mail", resolve: () => null });
    api.registerMcpServerRequestHeaderProvider({ serverName: "user-mail", resolve: replacement });
    api.registerMcpServerConnectionResolver({
      serverName: "user-mail",
      resolve: () => ({ url: "https://mcp.example.test/mail" }),
    });

    expect(registry.mcpServerRequestHeaderProviders).toMatchObject([
      { pluginId: "plugin-a", provider: { serverName: "user-mail" } },
    ]);
    expect(registry.mcpServerConnectionResolvers).toHaveLength(1);
    expect(registry.diagnostics).toEqual([]);
    expect(
      await registry.mcpServerRequestHeaderProviders[0]?.provider.resolve({
        sessionId: "session",
        runId: "run",
      }),
    ).toEqual({ traceparent: "replacement-trace" });
  });

  it.each(["provider", "resolver"] as const)(
    "rejects a different plugin's credentials when the %s registered first",
    (first) => {
      const { registry, apiFor } = createRegistryHarness();
      const owner = apiFor("plugin-a");
      const other = apiFor("plugin-b");
      const provider = { serverName: "user-mail", resolve: () => ({ traceparent: "owner-trace" }) };
      const resolver = {
        serverName: "user-mail",
        resolve: () => ({ url: "https://mcp.example.test/mail" }),
      };
      if (first === "provider") {
        owner.registerMcpServerRequestHeaderProvider(provider);
        other.registerMcpServerConnectionResolver(resolver);
        expect(registry.mcpServerConnectionResolvers).toEqual([]);
        expect(registry.mcpServerRequestHeaderProviders).toHaveLength(1);
      } else {
        owner.registerMcpServerConnectionResolver(resolver);
        other.registerMcpServerRequestHeaderProvider(provider);
        expect(registry.mcpServerRequestHeaderProviders).toEqual([]);
        expect(registry.mcpServerConnectionResolvers).toHaveLength(1);
      }
      expect(registry.diagnostics).toContainEqual(
        expect.objectContaining({
          level: "error",
          pluginId: "plugin-b",
          message: expect.stringContaining('already registered by plugin "plugin-a"'),
        }),
      );
    },
  );

  it("rejects an empty server name", () => {
    const { registry, apiFor } = createRegistryHarness();
    apiFor("plugin-a").registerMcpServerRequestHeaderProvider({
      serverName: " ",
      resolve: () => null,
    });
    expect(registry.mcpServerRequestHeaderProviders).toEqual([]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "error",
        message: expect.stringContaining("missing serverName"),
      }),
    );
  });
});
