// Approved plugins may load together, but metadata selection owns the engine factory.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPlugins } from "./loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { disposePluginRegistryInstances } from "./runtime.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

it.each([
  { legacyFirst: true, legacyRegisters: true },
  { legacyFirst: false, legacyRegisters: true },
  { legacyFirst: true, legacyRegisters: false },
])("preserves declared ownership with %j", async ({ legacyFirst, legacyRegisters }) => {
  const { resolveContextEngine } = await import("../context-engine/registry.js");
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
  const imported = path.join(workspaceDir, "imports");
  const factories = path.join(workspaceDir, "factories");
  const ids = legacyFirst ? ["existing-engine", "new-owner"] : ["new-owner", "existing-engine"];
  const plugins = ids.map((id) => {
    const registers = id === "new-owner" || legacyRegisters;
    const plugin = writePlugin({
      id,
      dir: path.join(workspaceDir, id),
      filename: "index.cjs",
      body: `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(imported)}, ${JSON.stringify(id + "\n")});
module.exports = { id: ${JSON.stringify(id)}, kind: "context-engine", register(api) {
  if (!${registers}) return;
  api.registerContextEngine("existing-engine", () => {
    fs.appendFileSync(${JSON.stringify(factories)}, ${JSON.stringify(id + "\n")});
    return {
      info: { id: "existing-engine", name: "Synthetic Engine" },
      ingest: async () => ({ ingested: true }),
      assemble: async () => ({ messages: [], estimatedTokens: 0, systemPromptAddition: ${JSON.stringify(id)} }),
      compact: async () => ({ ok: true, compacted: false }),
    };
  });
} };`,
    });
    if (id === "new-owner") {
      fs.writeFileSync(
        path.join(plugin.dir, "openclaw.plugin.json"),
        JSON.stringify({
          id,
          kind: "context-engine",
          contextEngineIds: ["existing-engine"],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        }),
      );
    }
    return plugin;
  });
  const config: OpenClawConfig = {
    plugins: {
      load: { paths: plugins.map((plugin) => plugin.file) },
      entries: { "existing-engine": { enabled: true }, "new-owner": { enabled: true } },
      slots: { memory: "none", contextEngine: "existing-engine" },
    },
  };
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir,
    cache: false,
    runtimeSideEffects: true,
  });
  try {
    expect(fs.readFileSync(imported, "utf8").trim().split("\n")).toEqual(ids);
    expect(registry.contextEngines.get("existing-engine")?.owner).toBe("plugin:new-owner");
    const engine = await resolveContextEngine(config);
    try {
      expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
        systemPromptAddition: "new-owner",
      });
      expect(fs.readFileSync(factories, "utf8")).toBe("new-owner\n");
    } finally {
      await engine.dispose?.();
    }
    expect(
      registry.diagnostics.some((entry) =>
        entry.message.includes("context engine already registered: existing-engine (plugin:new-owner)"),
      ),
    ).toBe(legacyRegisters);
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});
