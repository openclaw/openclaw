import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, assert, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveContextEngine } from "../context-engine/registry.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import {
  cleanupPluginLoaderFixturesForTest,
  EMPTY_PLUGIN_SCHEMA,
  useNoBundledPlugins,
  loadOpenClawPlugins,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  writePlugin,
  writePluginMetadata,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  disposePluginRegistryInstances,
  getActivePluginRegistry,
  getPluginRegistrationContext,
  listImportedRuntimePluginIds,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
});
afterAll(cleanupPluginLoaderFixturesForTest);

const discoveryFor = (...plugins: TempPlugin[]): PluginDiscoveryResult => ({
  candidates: plugins.map(({ id, dir, file }) => ({
    idHint: id,
    rootDir: dir,
    source: file,
    origin: "bundled",
  })),
  diagnostics: [],
});

const providerIds = (registry: ReturnType<typeof loadBundledCapabilityRuntimeRegistry>) =>
  registry.providers.map((entry) => entry.provider.id);

function capture(target: TempPlugin, others: TempPlugin[] = [], config?: OpenClawConfig) {
  return loadBundledCapabilityRuntimeRegistry({
    pluginIds: [target.id],
    discovery: discoveryFor(target, ...others),
    config,
  });
}

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("retains the bundled owner under an external shadow without rediscovering changed manifests", () => {
    const root = makePluginLoaderTempDir();
    const bundledRoot = path.join(root, "bundled");
    const target = writePlugin({
      id: "shadowed-capability",
      dir: path.join(bundledRoot, "shadowed-capability"),
      filename: "index.cjs",
      registration: `api.registerProvider({ id: "bundled-capability", label: "Bundled owner", auth: [] });`,
    });
    const shadow = writePlugin({
      id: target.id,
      body: 'throw new Error("external shadow imported");',
    });
    const config = { plugins: { load: { paths: [shadow.dir] } } };
    const env = {
      OPENCLAW_HOME: path.join(root, "home"),
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    };
    const snapshot = completePluginMetadataSnapshot({
      snapshot: loadPluginMetadataSnapshot({ config, env, preferPersisted: false }),
      config,
      env,
    });
    assert(snapshot);
    setGatewayPluginMetadataSnapshot(snapshot, { config, env });
    fs.writeFileSync(path.join(target.dir, "openclaw.plugin.json"), "{}");

    const load = (explicit = false) =>
      loadBundledCapabilityRuntimeRegistry({
        pluginIds: [target.id],
        config,
        env,
        ...(explicit && { discovery: discoveryFor(target) }),
      });
    expect(providerIds(load())).toEqual(["bundled-capability"]);
    expect(providerIds(load(true))).toEqual(["bundled-capability"]);
    const freshRegistry = withPluginCache(createPluginCache(), () => load(true));
    expect(freshRegistry.providers).toEqual([]);
    expect(freshRegistry.diagnostics).toContainEqual(
      expect.objectContaining({ pluginId: target.id, message: "plugin manifest requires id" }),
    );
  });

  it.each([false, true])(
    "loads only requested capabilities without activating a registry (channel=%s)",
    (channel) => {
      const target = writePlugin({
        id: "capability-target",
        registration: `if (api.registrationMode === "discovery") {
        api.registerProvider({ id: "capability-target", label: "Target", auth: [] });
        api.registerTranscriptSourceProvider({ id: "voice", name: "Voice", sourceKinds: ["meeting"] });
      }
      if (api.registrationMode === "full") {
        api.registerProvider({ id: "full-only", label: "Full only", auth: [] });
      }`,
      });
      if (channel) {
        writePluginMetadata({ dir: target.dir, id: target.id, channels: [target.id] });
      }
      const unscoped = writePlugin({
        id: "capability-unscoped",
        registration: `throw new Error("unscoped plugin loaded");`,
      });
      const active = createEmptyPluginRegistry();
      setActivePluginRegistry(active, "existing-registry");
      const activeSnapshotBefore = captureActivePluginRegistrySnapshot();
      const registrationContextBefore = getPluginRegistrationContext();

      const registry = capture(target, [unscoped]);

      expect(providerIds(registry)).toEqual([target.id]);
      expect(registry.transcriptSourceProviders.map((entry) => entry.provider.id)).toEqual([
        "voice",
      ]);
      expect(registry.typedHooks).toEqual([]);
      expect(getActivePluginRegistry()).toBe(active);
      expect(captureActivePluginRegistrySnapshot()).toEqual(activeSnapshotBefore);
      expect(getPluginRegistrationContext()).toBe(registrationContextBefore);
    },
  );

  it.each<[string, NonNullable<OpenClawConfig["plugins"]>]>([
    ["explicitly disabled", { entries: { "blocked-capability": { enabled: false } } }],
    ["denylisted", { deny: ["blocked-capability"] }],
    ["outside the allowlist", { allow: ["allowed-capability"] }],
    ["globally disabled", { enabled: false }],
  ])("never imports a %s plugin", (_name, plugins) => {
    const blocked = writePlugin({
      id: "blocked-capability",
      registration: `api.registerProvider({ id: "blocked-capability", label: "Blocked", auth: [] });`,
    });

    expect(capture(blocked, [], { plugins }).providers).toEqual([]);
    expect(listImportedRuntimePluginIds()).not.toContain(blocked.id);
  });
});

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
  const load = (rootConfig: OpenClawConfig) =>
    loadOpenClawPlugins({
      config: rootConfig,
      workspaceDir,
      cache: false,
      runtimeSideEffects: true,
    });
  return { imported, factories, config, load };
}

const approvals = (legacy = true, declared = true) => ({
  "existing-engine": { enabled: legacy },
  "new-owner": { enabled: declared },
});

it.each([true, false])(
  "rejects eligible legacy/declared collision before either import: legacy first=%s",
  (legacyFirst) => {
    const fixture = setupOwners(legacyFirst);
    expect(() => fixture.load(fixture.config(approvals()))).toThrow(
      /ambiguous approved owners: existing-engine, new-owner/,
    );
    expect(fs.existsSync(fixture.imported)).toBe(false);
    expect(fs.existsSync(fixture.factories)).toBe(false);
  },
);

it.each<[string, NonNullable<OpenClawConfig["plugins"]>["entries"], string, string[]?]>([
  ["unapproved legacy", { "new-owner": { enabled: true } }, "new-owner"],
  ["denied legacy", approvals(false), "new-owner"],
  ["denied declaration", approvals(true, false), "existing-engine"],
  ["denylisted legacy", approvals(), "new-owner", ["existing-engine"]],
  ["denylisted declaration", approvals(), "existing-engine", ["new-owner"]],
])("allows %s and assembles with the eligible owner", async (_policy, entries, winner, deny) => {
  const fixture = setupOwners(false);
  const config = fixture.config(entries, "existing-engine", deny);
  const registry = fixture.load(config);
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
  const registry = fixture.load(fixture.config(approvals(), "none"));
  try {
    expect(fs.readFileSync(fixture.imported, "utf8").trim().split("\n")).toEqual([
      "existing-engine",
      "new-owner",
    ]);
    expect([...registry.contextEngines.keys()]).toEqual(["existing-engine", "new-engine"]);
  } finally {
    await disposePluginRegistryInstances(registry);
  }
});
