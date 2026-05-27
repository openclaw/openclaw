import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "./loader-records.js";
import { createPluginRegistry } from "./registry.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { createPluginRuntime } from "./runtime/index.js";
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
  it("adds plugin context to lazy runtime resolution failures", () => {
    const runtime = new Proxy({} as PluginRuntime, {
      get() {
        throw new Error("Unable to resolve plugin runtime module; loader=/tmp/openclaw-loader.js");
      },
    });
    const pluginRegistry = createTestRegistry(runtime);
    const record = createPluginRecord({
      id: "diagnostic-plugin",
      name: "Diagnostic Plugin",
      source: "/plugins/diagnostic-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config: {} as OpenClawConfig });

    let thrown: unknown;
    try {
      void api.runtime.version;
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("Unable to resolve plugin runtime module");
    expect(message).toContain("pluginRuntimeContext=pluginId:diagnostic-plugin");
    expect(message).toContain("property:version");
    expect(message).toContain("source:/plugins/diagnostic-plugin/index.js");
  });

  it("runs config helpers with the owning plugin scope", async () => {
    let currentScope = getPluginRuntimeGatewayRequestScope();
    let mutateScope = getPluginRuntimeGatewayRequestScope();
    let replaceScope = getPluginRuntimeGatewayRequestScope();
    let loadScope = getPluginRuntimeGatewayRequestScope();
    let writeScope = getPluginRuntimeGatewayRequestScope();
    const config = {} as OpenClawConfig;
    const replaceResult = {
      path: "/tmp/openclaw.json",
      previousHash: null,
      persistedHash: "persisted-hash",
      snapshot: { path: "/tmp/openclaw.json" },
      nextConfig: config,
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    } as unknown as Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const configRuntime = {
      current: vi.fn(() => {
        currentScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- mirrors the runtime API generic result contract.
      mutateConfigFile: async <T = void>() => {
        mutateScope = getPluginRuntimeGatewayRequestScope();
        return {
          ...replaceResult,
          result: undefined as T | undefined,
        };
      },
      replaceConfigFile: async () => {
        replaceScope = getPluginRuntimeGatewayRequestScope();
        return replaceResult;
      },
      loadConfig: vi.fn(() => {
        loadScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      writeConfigFile: async () => {
        writeScope = getPluginRuntimeGatewayRequestScope();
      },
    } satisfies PluginRuntime["config"];
    const runtime = createPluginRuntime();
    runtime.config = configRuntime;
    const pluginRegistry = createTestRegistry(runtime);
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
      afterWrite: { mode: "none", reason: "test" },
      mutate: () => undefined,
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: config,
      afterWrite: { mode: "none", reason: "test" },
    });
    expect(api.runtime.config["loadConfig"]()).toBe(config);
    await api.runtime.config["writeConfigFile"](config);

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
