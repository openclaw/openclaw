import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";

function createTestRegistry(runtime: PluginRuntime) {
  return createPluginRegistry({
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
    },
    runtime,
    activateGlobalSideEffects: false,
  });
}

describe("plugin registry runtime config scope", () => {
  it("runs deprecated config helpers with the owning plugin scope", async () => {
    let currentScope = getPluginRuntimeGatewayRequestScope();
    let mutateScope = getPluginRuntimeGatewayRequestScope();
    let replaceScope = getPluginRuntimeGatewayRequestScope();
    const config = {} as OpenClawConfig;
    const replaceResult = {
      previousHash: null,
      nextHash: "next",
    } as unknown as Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const configRuntime = {
      current: vi.fn(() => {
        currentScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      mutateConfigFile: vi.fn(async () => {
        mutateScope = getPluginRuntimeGatewayRequestScope();
        return {
          ...replaceResult,
          result: undefined,
        };
      }) as PluginRuntime["config"]["mutateConfigFile"],
      replaceConfigFile: vi.fn(async () => {
        replaceScope = getPluginRuntimeGatewayRequestScope();
        return replaceResult;
      }),
      loadConfig: vi.fn(() => config) as unknown as PluginRuntime["config"]["loadConfig"],
      writeConfigFile: vi.fn(
        async () => {},
      ) as unknown as PluginRuntime["config"]["writeConfigFile"],
    } satisfies PluginRuntime["config"];
    const pluginRegistry = createTestRegistry({
      config: configRuntime,
    } as unknown as PluginRuntime);
    const record = createPluginRecord({
      id: "legacy-plugin",
      name: "Legacy Plugin",
      source: "/plugins/legacy-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config });

    expect(api.runtime.config.current()).toBe(config);
    await api.runtime.config.mutateConfigFile({
      mutate: () => {},
      afterWrite: { mode: "none", reason: "test" },
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: config,
      afterWrite: { mode: "none", reason: "test" },
    });

    expect(currentScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(mutateScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(replaceScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
  });
});
