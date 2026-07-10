// Covers the in-process restart boundary: cached plugin registries must drop so
// updated workspace plugin source on disk loads on the next startup (#103571).
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { clearPluginCachesForInProcessRestart, loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makeTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

function pluginBody(toolName: string): string {
  return `module.exports = {
  id: "restart-reload-probe",
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(toolName)},
      description: "restart reload probe tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  },
};`;
}

function writeManifest(dir: string, toolName: string, id = "restart-reload-probe"): void {
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id,
        configSchema: { type: "object", additionalProperties: false },
        contracts: { tools: [toolName] },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function loadedToolNames(registry: ReturnType<typeof loadOpenClawPlugins>): string[] {
  return registry.tools.flatMap((entry) => entry.names);
}

describe("plugin loader in-process restart reload", () => {
  it("loads updated workspace plugin code after the restart-boundary cache clear (#103571)", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "restart-reload-probe",
      filename: "restart-reload-probe.cjs",
      body: pluginBody("probe_tool_v1"),
    });
    writeManifest(plugin.dir, "probe_tool_v1");
    const config = {
      plugins: {
        load: { paths: [plugin.dir] },
        allow: ["restart-reload-probe"],
      },
    };

    const first = loadOpenClawPlugins({ config });
    expect(loadedToolNames(first)).toContain("probe_tool_v1");

    // Update the plugin source (and its declared tool contract) on disk — the
    // issue's repro step 3: add a tool, expect it after an in-process restart.
    fs.writeFileSync(plugin.file, pluginBody("probe_tool_v2"), "utf-8");
    writeManifest(plugin.dir, "probe_tool_v2");

    // Without the restart-boundary clear the cached registry re-serves the old
    // module graph — the stale behavior reported for in-process restarts.
    const stale = loadOpenClawPlugins({ config });
    expect(loadedToolNames(stale)).toContain("probe_tool_v1");
    expect(loadedToolNames(stale)).not.toContain("probe_tool_v2");

    // The in-process restart boundary drops plugin caches, so the next startup
    // loads the updated source from disk.
    clearPluginCachesForInProcessRestart();
    const reloaded = loadOpenClawPlugins({ config });
    expect(loadedToolNames(reloaded)).toContain("probe_tool_v2");
    expect(loadedToolNames(reloaded)).not.toContain("probe_tool_v1");
  });

  it("reloads plugin-local imported modules, not just the entrypoint (#103688 review)", () => {
    useNoBundledPlugins();
    const plugin = writePlugin({
      id: "restart-local-dep-probe",
      filename: "restart-local-dep-probe.cjs",
      body: `module.exports = {
  id: "restart-local-dep-probe",
  register(api) {
    const helper = require("./helper.cjs");
    api.registerTool({
      name: helper.toolName,
      description: "restart reload probe tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  },
};`,
    });
    const helperPath = path.join(plugin.dir, "helper.cjs");
    fs.writeFileSync(helperPath, 'module.exports = { toolName: "helper_tool_v1" };', "utf-8");
    writeManifest(plugin.dir, "helper_tool_v1", "restart-local-dep-probe");
    const config = {
      plugins: { load: { paths: [plugin.file] }, allow: ["restart-local-dep-probe"] },
    };

    expect(loadedToolNames(loadOpenClawPlugins({ config }))).toContain("helper_tool_v1");

    // Edit only the plugin-LOCAL dependency; a fresh entrypoint must not be paired
    // with this stale cached helper (the mixed-runtime hazard).
    fs.writeFileSync(helperPath, 'module.exports = { toolName: "helper_tool_v2" };', "utf-8");
    writeManifest(plugin.dir, "helper_tool_v2", "restart-local-dep-probe");

    clearPluginCachesForInProcessRestart();
    const reloaded = loadOpenClawPlugins({ config });
    expect(loadedToolNames(reloaded)).toContain("helper_tool_v2");
    expect(loadedToolNames(reloaded)).not.toContain("helper_tool_v1");
  });

  it("evicts package-root modules for nested entrypoints on restart (#103688 review)", () => {
    useNoBundledPlugins();
    // Layout: <root>/openclaw.plugin.json + package.json(main: dist/entry.cjs)
    //         <root>/dist/entry.cjs  → requires ../lib/helper.cjs (OUTSIDE dist/)
    const root = path.join(makeTempDir(), "nested-root-probe");
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "nested-root-probe",
        main: "dist/entry.cjs",
        openclaw: { extensions: ["dist/entry.cjs"] },
      }),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(root, "dist", "entry.cjs"),
      `module.exports = {
  id: "nested-root-probe",
  register(api) {
    const helper = require("../lib/helper.cjs");
    api.registerTool({
      name: helper.toolName,
      description: "nested probe tool",
      parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
    });
  },
};`,
      "utf-8",
    );
    const helperPath = path.join(root, "lib", "helper.cjs");
    fs.writeFileSync(helperPath, 'module.exports = { toolName: "nested_tool_v1" };', "utf-8");
    const writeNestedManifest = (toolName: string) => {
      fs.writeFileSync(
        path.join(root, "openclaw.plugin.json"),
        JSON.stringify({
          id: "nested-root-probe",
          configSchema: { type: "object", additionalProperties: false },
          contracts: { tools: [toolName] },
        }),
        "utf-8",
      );
    };
    writeNestedManifest("nested_tool_v1");
    const config = {
      plugins: { load: { paths: [root] }, allow: ["nested-root-probe"] },
    };

    expect(loadedToolNames(loadOpenClawPlugins({ config }))).toContain("nested_tool_v1");

    // Edit only the module OUTSIDE the entrypoint directory: entry-dir-scoped
    // eviction misses it, so the fresh entry pairs with a stale helper.
    fs.writeFileSync(helperPath, 'module.exports = { toolName: "nested_tool_v2" };', "utf-8");
    writeNestedManifest("nested_tool_v2");

    clearPluginCachesForInProcessRestart();
    const reloaded = loadOpenClawPlugins({ config });
    expect(loadedToolNames(reloaded)).toContain("nested_tool_v2");
    expect(loadedToolNames(reloaded)).not.toContain("nested_tool_v1");
  });
});
