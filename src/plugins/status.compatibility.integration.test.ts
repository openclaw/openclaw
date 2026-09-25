/** Integration coverage for plugin status compatibility output and installed-index state. */
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  cleanupPluginLoaderFixturesForTest,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { buildPluginRuntimeLoadOptions } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";
import { buildPluginCompatibilitySnapshotNotices } from "./status.js";

describe("plugin compatibility snapshot notices", () => {
  afterEach(() => {
    resetPluginLoaderTestStateForTest();
  });

  afterAll(() => {
    cleanupPluginLoaderFixturesForTest();
  });

  it("reports actual hook-only registrations without activating cold plugin modules", () => {
    const pluginDir = makePluginLoaderTempDir();
    const runtimeMarker = path.join(pluginDir, "runtime-loaded");
    const plugin = writePlugin({
      id: "runtime-hook-only",
      dir: pluginDir,
      body: `module.exports = { id: "runtime-hook-only", register(api) { require("node:fs").writeFileSync(${JSON.stringify(runtimeMarker)}, "loaded"); api.on("message_received", () => {}); } };\n`,
    });
    const stateDir = makePluginLoaderTempDir();
    const config = {
      plugins: {
        load: { paths: [plugin.file] },
        allow: [plugin.id],
      },
    };

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      useNoBundledPlugins();
      const params = { config, workspaceDir: plugin.dir, env: process.env };

      expect(buildPluginCompatibilitySnapshotNotices(params)).toStrictEqual([]);
      expect(fs.existsSync(runtimeMarker)).toBe(false);

      // Activate through the resolved runtime context like Gateway and CLI loads do:
      // the load identity includes the resolved physical sources, and the snapshot
      // path only reuses an active registry whose identity matches exactly.
      const registry = loadOpenClawPlugins(
        buildPluginRuntimeLoadOptions(resolvePluginRuntimeLoadContext(params), { cache: false }),
      );
      expect(fs.existsSync(runtimeMarker)).toBe(true);
      expect(registry.typedHooks).toEqual([
        expect.objectContaining({ pluginId: plugin.id, hookName: "message_received" }),
      ]);
      expect(buildPluginCompatibilitySnapshotNotices(params)).toEqual([
        expect.objectContaining({ pluginId: plugin.id, code: "hook-only" }),
      ]);
    });
  });
});
