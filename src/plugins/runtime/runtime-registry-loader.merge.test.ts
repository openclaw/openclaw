// Verifies ensureScopedPluginsLoadedPreservingActive against real plugin
// loading (no mocks): a scoped harness-activation load must not evict, or
// re-register, an unrelated plugin that is already active
// (openclaw/openclaw#107408).
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { loadOpenClawPlugins } from "../loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../loader.test-fixtures.js";
import { getActivePluginRegistry, resetPluginRuntimeStateForTest } from "../runtime.js";
import { ensureScopedPluginsLoadedPreservingActive } from "./runtime-registry-loader.js";

const REGISTER_COUNT_KEY = "__pr107596UnrelatedPluginRegisterCount";

function unrelatedPluginRegisterCount(): number {
  return ((globalThis as Record<string, unknown>)[REGISTER_COUNT_KEY] as number | undefined) ?? 0;
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[REGISTER_COUNT_KEY];
  resetPluginRuntimeStateForTest();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

describe("ensureScopedPluginsLoadedPreservingActive", () => {
  it("preserves an already-active unrelated plugin's registrations across a scoped load for a missing plugin", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const unrelated = writePlugin({
      id: "unrelated-plugin",
      filename: "unrelated-plugin.cjs",
      body: `module.exports = {
        id: "unrelated-plugin",
        register(api) {
          globalThis[${JSON.stringify(REGISTER_COUNT_KEY)}] =
            (globalThis[${JSON.stringify(REGISTER_COUNT_KEY)}] || 0) + 1;
          api.registerCliBackend({ id: "unrelated-cli", config: { command: "unrelated" } });
        },
      };`,
    });
    const harnessOwner = writePlugin({
      id: "harness-owner-plugin",
      filename: "harness-owner-plugin.cjs",
      body: `module.exports = {
        id: "harness-owner-plugin",
        register(api) {
          api.registerCliBackend({ id: "harness-owner-cli", config: { command: "harness-owner" } });
        },
      };`,
    });

    // Load and activate "unrelated-plugin" as the live active registry, the
    // same way a normal plugin activation would.
    loadOpenClawPlugins({
      workspaceDir,
      cache: false,
      onlyPluginIds: ["unrelated-plugin"],
      config: {
        plugins: {
          load: { paths: [unrelated.file] },
          allow: ["unrelated-plugin"],
          entries: { "unrelated-plugin": { enabled: true } },
        },
      },
    });
    const activeBefore = getActivePluginRegistry();
    expect(activeBefore).not.toBeNull();
    expect(unrelatedPluginRegisterCount()).toBe(1);
    expect(activeBefore?.cliBackends.map((entry) => entry.pluginId)).toContain("unrelated-plugin");

    // A scoped harness-activation load now asks only for "harness-owner-plugin"
    // (mirrors ensureSelectedAgentHarnessPlugin's onlyPluginIds — it never
    // includes "unrelated-plugin").
    ensureScopedPluginsLoadedPreservingActive({
      workspaceDir,
      config: {
        plugins: {
          load: { paths: [harnessOwner.file] },
          allow: ["harness-owner-plugin"],
          entries: { "harness-owner-plugin": { enabled: true } },
        },
      },
      onlyPluginIds: ["harness-owner-plugin"],
    });

    const activeAfter = getActivePluginRegistry();
    // Mutated in place, never swapped — same object reference.
    expect(activeAfter).toBe(activeBefore);
    const pluginIds = activeAfter?.plugins.map((p) => p.id).toSorted();
    expect(pluginIds).toEqual(["harness-owner-plugin", "unrelated-plugin"]);
    const cliBackendPluginIds = activeAfter?.cliBackends.map((entry) => entry.pluginId).toSorted();
    expect(cliBackendPluginIds).toEqual(["harness-owner-plugin", "unrelated-plugin"]);

    // The core regression: "unrelated-plugin"'s register() must not have run
    // again just because an unrelated harness plugin was scoped-loaded.
    expect(unrelatedPluginRegisterCount()).toBe(1);
  });

  it("is a no-op when every requested id is already active", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    const plugin = writePlugin({
      id: "already-active-plugin",
      filename: "already-active-plugin.cjs",
      body: `module.exports = {
        id: "already-active-plugin",
        register(api) {
          globalThis[${JSON.stringify(REGISTER_COUNT_KEY)}] =
            (globalThis[${JSON.stringify(REGISTER_COUNT_KEY)}] || 0) + 1;
          api.registerCliBackend({ id: "already-active-cli", config: { command: "x" } });
        },
      };`,
    });

    loadOpenClawPlugins({
      workspaceDir,
      cache: false,
      onlyPluginIds: ["already-active-plugin"],
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["already-active-plugin"],
          entries: { "already-active-plugin": { enabled: true } },
        },
      },
    });
    expect(unrelatedPluginRegisterCount()).toBe(1);
    const activeBefore = getActivePluginRegistry();

    ensureScopedPluginsLoadedPreservingActive({
      workspaceDir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["already-active-plugin"],
          entries: { "already-active-plugin": { enabled: true } },
        },
      },
      onlyPluginIds: ["already-active-plugin"],
    });

    expect(getActivePluginRegistry()).toBe(activeBefore);
    expect(unrelatedPluginRegisterCount()).toBe(1);
  });

  it("loads the requested plugin normally when nothing is active yet", async () => {
    useNoBundledPlugins();
    const workspaceDir = makeTempDir();
    resetPluginRuntimeStateForTest();
    expect(getActivePluginRegistry()).toBeNull();
    const plugin = writePlugin({
      id: "first-load-plugin",
      filename: "first-load-plugin.cjs",
      body: `module.exports = {
        id: "first-load-plugin",
        register(api) {
          api.registerCliBackend({ id: "first-load-cli", config: { command: "x" } });
        },
      };`,
    });

    ensureScopedPluginsLoadedPreservingActive({
      workspaceDir,
      config: {
        plugins: {
          load: { paths: [plugin.file] },
          allow: ["first-load-plugin"],
          entries: { "first-load-plugin": { enabled: true } },
        },
      },
      onlyPluginIds: ["first-load-plugin"],
    });

    expect(getActivePluginRegistry()?.cliBackends.map((entry) => entry.pluginId)).toContain(
      "first-load-plugin",
    );
  });
});
