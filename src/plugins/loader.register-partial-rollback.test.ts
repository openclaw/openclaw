// Regression: when a plugin's register() throws midway, the catch block used
// to restore only the process-global runtime state (agent harnesses,
// compaction providers, memory embedding providers, memory plugin state).
// Anything the plugin had already pushed into the shared registry arrays —
// httpRoutes, services, hooks, commands, channels, providers, and so on —
// stayed in place. Consumers (gateway plugins-http, plugin service runner,
// hook runner) iterate those arrays without checking plugin.status, so the
// half-registered entries from an error-status plugin would still be served
// as if the plugin had loaded cleanly.
//
// The fix snapshots every array field on the registry before register() runs
// and restores the snapshot on the catch path, matching the invariant the
// process-global restores already uphold.

import { afterAll, afterEach, describe, expect, it } from "vitest";
import { listContextEngineIds } from "../context-engine/registry.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

describe("plugin register() throw rolls back partial registry contributions", () => {
  afterEach(() => {
    resetPluginLoaderTestStateForTest();
  });

  afterAll(() => {
    cleanupPluginLoaderFixturesForTest();
  });

  it("clears the plugin record's counter/id arrays when register fails", () => {
    // Status / inspect surfaces read `record.services`, `record.gatewayMethods`,
    // `record.httpRoutes`, etc. directly off PluginRegistry.plugins[]. If these
    // are left populated after a failing register(), the error-status plugin
    // still advertises the capabilities it tried (and failed) to contribute.
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "partial-record",
      filename: "partial-record.cjs",
      body: `module.exports = {
        id: "partial-record",
        register(api) {
          api.registerHttpRoute({
            path: "/orphan-record",
            auth: "plugin",
            handler: async () => new Response(null, { status: 204 }),
          });
          api.registerService({
            id: "orphan-record-service",
            start: async () => {},
          });
          api.registerGatewayMethod(
            "plugin.orphan.record",
            async () => ({ ok: true }),
          );
          throw new Error("register failed after partial record mutations");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["partial-record"],
        },
      },
      onlyPluginIds: ["partial-record"],
    });

    const record = registry.plugins.find((entry) => entry.id === "partial-record");
    expect(record?.status).toBe("error");
    // The failing register() had incremented record.httpRoutes and pushed
    // onto record.services / record.gatewayMethods. Those must all revert so
    // status UIs don't report a phantom capability for the error plugin.
    expect(record?.httpRoutes).toBe(0);
    expect(record?.services).toEqual([]);
    expect(record?.gatewayMethods).toEqual([]);
  });

  it("releases registered context engines when register fails", () => {
    // The context-engine registry keeps process-global state. If register()
    // throws after api.registerContextEngine(), the record's contextEngineIds
    // must be cleared AND the global entry released, otherwise an orphan
    // engine stays selectable while the plugin reports status "error".
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "partial-context-engine",
      filename: "partial-context-engine.cjs",
      body: `module.exports = {
        id: "partial-context-engine",
        register(api) {
          api.registerContextEngine("plugin.orphan.context-engine", () => ({
            bootstrap: async () => {},
            maintain: async () => {},
            assemble: async () => ({ sections: [] }),
          }));
          throw new Error("register failed after registerContextEngine");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["partial-context-engine"],
        },
      },
      onlyPluginIds: ["partial-context-engine"],
    });

    const record = registry.plugins.find((entry) => entry.id === "partial-context-engine");
    expect(record?.status).toBe("error");
    // Record and global context-engine registry must agree: both empty.
    expect(record?.contextEngineIds ?? []).toEqual([]);
    expect(listContextEngineIds()).not.toContain("plugin.orphan.context-engine");
  });

  it("clears newly-registered gatewayHandlers/gatewayMethodScopes when register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "partial-gateway",
      filename: "partial-gateway.cjs",
      body: `module.exports = {
        id: "partial-gateway",
        register(api) {
          api.registerGatewayMethod(
            "plugin.orphan.ping",
            async () => ({ ok: true }),
            { scope: "operator.read" },
          );
          throw new Error("register failed after gateway method");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["partial-gateway"],
        },
      },
      onlyPluginIds: ["partial-gateway"],
    });

    expect(registry.plugins.find((entry) => entry.id === "partial-gateway")?.status).toBe("error");
    // gatewayHandlers and gatewayMethodScopes are plain-object registries, not
    // arrays, so the rollback must specifically clear newly-added keys.
    expect(registry.gatewayHandlers["plugin.orphan.ping"]).toBeUndefined();
    expect(registry.gatewayMethodScopes?.["plugin.orphan.ping"]).toBeUndefined();
  });

  it("clears newly-registered httpRoutes/services when register fails", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "partial-register",
      filename: "partial-register.cjs",
      body: `module.exports = {
        id: "partial-register",
        register(api) {
          api.registerHttpRoute({
            path: "/orphan",
            auth: "plugin",
            handler: async () => new Response(null, { status: 204 }),
          });
          api.registerService({
            id: "orphan-service",
            start: async () => {},
          });
          throw new Error("register failed after partial contributions");
        },
      };`,
    });

    const registry = loadOpenClawPlugins({
      cache: false,
      workspaceDir: plugin.dir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["partial-register"],
        },
      },
      onlyPluginIds: ["partial-register"],
    });

    expect(registry.plugins.find((entry) => entry.id === "partial-register")?.status).toBe("error");
    // The plugin entered error status, so none of its registry contributions
    // should survive for unfiltered consumers (gateway plugins-http, services
    // runner) to pick up.
    expect(registry.httpRoutes).toHaveLength(0);
    expect(registry.services).toHaveLength(0);
  });
});
