import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveContextEngine } from "../context-engine/registry.js";
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

function setupOwners(legacyFirst: boolean, declaredEngineId = "existing-engine") {
  useNoBundledPlugins();
  const workspaceDir = makePluginLoaderTempDir();
  vi.stubEnv("OPENCLAW_STATE_DIR", makePluginLoaderTempDir());
  const imported = path.join(workspaceDir, "imports");
  const factories = path.join(workspaceDir, "factories");
  const ids = legacyFirst ? ["existing-engine", "new-owner"] : ["new-owner", "existing-engine"];
  const plugins = ids.map((id) => {
    const engineId = id === "new-owner" ? declaredEngineId : "existing-engine";
    const plugin = writePlugin({
      id,
      dir: path.join(workspaceDir, id),
      filename: "index.cjs",
      body: `const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(imported)}, ${JSON.stringify(id + "\n")});
module.exports = { id: ${JSON.stringify(id)}, kind: "context-engine", register(api) {
  api.registerContextEngine(${JSON.stringify(engineId)}, () => {
    fs.appendFileSync(${JSON.stringify(factories)}, ${JSON.stringify(id + "\n")});
    return {
      info: { id: ${JSON.stringify(engineId)}, name: "Synthetic Engine" },
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
          contextEngineIds: [engineId],
          configSchema: EMPTY_PLUGIN_SCHEMA,
        }),
      );
    }
    return plugin;
  });
  const config = (
    entries: NonNullable<OpenClawConfig["plugins"]>["entries"],
    engineId = "existing-engine",
    deny: string[] = [],
  ): OpenClawConfig => ({
    plugins: {
      load: { paths: plugins.map((plugin) => plugin.file) },
      entries,
      deny,
      slots: { memory: "none", contextEngine: engineId },
    },
  });
  return { workspaceDir, imported, factories, config };
}

it.each([true, false])(
  "rejects eligible legacy/declared collision before either import: legacy first=%s",
  (legacyFirst) => {
    const fixture = setupOwners(legacyFirst);
    expect(() =>
      loadOpenClawPlugins({
        config: fixture.config({
          "existing-engine": { enabled: true },
          "new-owner": { enabled: true },
        }),
        workspaceDir: fixture.workspaceDir,
        cache: false,
        runtimeSideEffects: true,
      }),
    ).toThrow(/ambiguous approved owners: existing-engine, new-owner/);
    expect(fs.existsSync(fixture.imported)).toBe(false);
    expect(fs.existsSync(fixture.factories)).toBe(false);
  },
);

it.each<{
  policy: string;
  entries: NonNullable<OpenClawConfig["plugins"]>["entries"];
  deny?: string[];
  winner: string;
}>([
  { policy: "unapproved legacy", entries: { "new-owner": { enabled: true } }, winner: "new-owner" },
  {
    policy: "denied legacy",
    entries: { "existing-engine": { enabled: false }, "new-owner": { enabled: true } },
    winner: "new-owner",
  },
  {
    policy: "denied declaration",
    entries: { "existing-engine": { enabled: true }, "new-owner": { enabled: false } },
    winner: "existing-engine",
  },
  {
    policy: "denylisted legacy",
    entries: { "existing-engine": { enabled: true }, "new-owner": { enabled: true } },
    deny: ["existing-engine"],
    winner: "new-owner",
  },
  {
    policy: "denylisted declaration",
    entries: { "existing-engine": { enabled: true }, "new-owner": { enabled: true } },
    deny: ["new-owner"],
    winner: "existing-engine",
  },
])("allows $policy and assembles with $winner", async ({ entries, deny, winner }) => {
  const fixture = setupOwners(false);
  const config = fixture.config(entries, "existing-engine", deny);
  const registry = loadOpenClawPlugins({
    config,
    workspaceDir: fixture.workspaceDir,
    cache: false,
    runtimeSideEffects: true,
  });
  try {
    expect(registry.contextEngines.get("existing-engine")?.owner).toBe(`plugin:${winner}`);
    const engine = await resolveContextEngine(config);
    try {
      expect(await engine.assemble({ sessionId: "synthetic", messages: [] })).toMatchObject({
        systemPromptAddition: winner,
      });
      expect(fs.readFileSync(fixture.factories, "utf8")).toBe(`${winner}\n`);
    } finally {
      await engine.dispose?.();
    }
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});

it("loads independently approved capabilities when the engine selector does not collide", async () => {
  const fixture = setupOwners(true, "new-engine");
  const registry = loadOpenClawPlugins({
    config: fixture.config(
      { "existing-engine": { enabled: true }, "new-owner": { enabled: true } },
      "none",
    ),
    workspaceDir: fixture.workspaceDir,
    cache: false,
    runtimeSideEffects: true,
  });
  try {
    expect(fs.readFileSync(fixture.imported, "utf8").trim().split("\n")).toEqual([
      "existing-engine",
      "new-owner",
    ]);
    expect(
      registry.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id),
    ).toEqual(["existing-engine", "new-owner"]);
    expect([...registry.contextEngines.keys()]).toEqual(["existing-engine", "new-engine"]);
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});
