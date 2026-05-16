import { describe, expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../config/types.openclaw.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRuntimeMock } from "../plugin-sdk/test-helpers/plugin-runtime-mock.js";
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
  it("runs config mutations with the owning plugin scope", async () => {
    let mutateScope = getPluginRuntimeGatewayRequestScope();
    let replaceScope = getPluginRuntimeGatewayRequestScope();
    let currentScope = getPluginRuntimeGatewayRequestScope();
    let loadScope = getPluginRuntimeGatewayRequestScope();
    let writeScope = getPluginRuntimeGatewayRequestScope();
    const config: OpenClawConfig = {};
    const snapshot: ConfigFileSnapshot = {
      path: "/tmp/openclaw/config.json",
      exists: true,
      raw: "{}",
      parsed: {},
      sourceConfig: config,
      resolved: config,
      valid: true,
      runtimeConfig: config,
      config,
      issues: [],
      warnings: [],
      legacyIssues: [],
    };
    const replaceResult = {
      path: snapshot.path,
      previousHash: null,
      snapshot,
      nextConfig: config,
      persistedHash: "persisted-hash",
      afterWrite: { mode: "auto" },
      followUp: { mode: "auto", requiresRestart: false },
    } satisfies Awaited<ReturnType<PluginRuntime["config"]["replaceConfigFile"]>>;
    const mutateConfigFile: PluginRuntime["config"]["mutateConfigFile"] = async (params) => {
      mutateScope = getPluginRuntimeGatewayRequestScope();
      await params.mutate(config, {
        snapshot,
        previousHash: replaceResult.previousHash,
      });
      return {
        ...replaceResult,
        afterWrite: params.afterWrite,
        result: undefined,
        attempts: 1,
      };
    };
    const replaceConfigFile: PluginRuntime["config"]["replaceConfigFile"] = async (params) => {
      replaceScope = getPluginRuntimeGatewayRequestScope();
      return {
        ...replaceResult,
        nextConfig: params.nextConfig,
        afterWrite: params.afterWrite,
      };
    };
    const loadConfig: PluginRuntime["config"]["loadConfig"] = () => {
      loadScope = getPluginRuntimeGatewayRequestScope();
      return config;
    };
    const writeConfigFile: PluginRuntime["config"]["writeConfigFile"] = async () => {
      writeScope = getPluginRuntimeGatewayRequestScope();
    };
    const configRuntime = {
      current: vi.fn(() => {
        currentScope = getPluginRuntimeGatewayRequestScope();
        return config;
      }),
      mutateConfigFile,
      replaceConfigFile,
      loadConfig,
      writeConfigFile,
    };
    const pluginRegistry = createTestRegistry(createPluginRuntimeMock({ config: configRuntime }));
    const record = createPluginRecord({
      id: "legacy-plugin",
      name: "Legacy Plugin",
      source: "/plugins/legacy-plugin/index.js",
      origin: "global",
      enabled: true,
      configSchema: false,
    });
    const api = pluginRegistry.createApi(record, { config });

    await api.runtime.config.mutateConfigFile({
      afterWrite: { mode: "none", reason: "test" },
      mutate: () => "mutated",
    });
    await api.runtime.config.replaceConfigFile({
      nextConfig: config,
      afterWrite: { mode: "restart", reason: "test" },
    });
    expect(api.runtime.config.current()).toBe(config);
    const legacyLoadConfig = api.runtime.config["loadConfig"];
    const legacyWriteConfigFile = api.runtime.config["writeConfigFile"];
    expect(legacyLoadConfig()).toBe(config);
    await legacyWriteConfigFile(config);

    expect(mutateScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(replaceScope).toMatchObject({
      pluginId: "legacy-plugin",
      pluginSource: "/plugins/legacy-plugin/index.js",
    });
    expect(currentScope).toMatchObject({
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
