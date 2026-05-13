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
    let loadScope = getPluginRuntimeGatewayRequestScope();
    let writeScope = getPluginRuntimeGatewayRequestScope();
    const config = {} as OpenClawConfig;
    const replaceResult = {
      previousHash: null,
      nextHash: "next",
    } as unknown as Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const configRuntime = {
      current: vi.fn(() => config),
      mutateConfigFile: async <T = void>() => ({
        ...replaceResult,
        result: undefined as T | undefined,
      }),
      replaceConfigFile: async () => replaceResult,
      loadConfig: vi.fn(() => {
        loadScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      writeConfigFile: vi.fn(async () => {
        writeScope = getPluginRuntimeGatewayRequestScope();
      }),
    } satisfies PluginRuntime["config"];
    const pluginRegistry = createTestRegistry({ config: configRuntime } as PluginRuntime);
    const record = createPluginRecord({
      id: "legacy-plugin",
      name: "Legacy Plugin",
      source: "/plugins/legacy-plugin/index.js",
      origin: "global",
      enabled: true,
    });
    const api = pluginRegistry.createApi(record, { config });

    expect(api.runtime.config.loadConfig()).toBe(config);
    await api.runtime.config.writeConfigFile(config);

    expect(loadScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(writeScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
  });
});
