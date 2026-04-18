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
