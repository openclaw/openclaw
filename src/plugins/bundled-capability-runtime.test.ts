import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, assert, describe, expect, it } from "vitest";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  writePlugin,
} from "./loader.test-fixtures.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  completePluginMetadataSnapshot,
  loadPluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  getPluginRegistrationContext,
  listImportedRuntimePluginIds,
  setActivePluginRegistry,
} from "./runtime.js";

afterEach(resetPluginLoaderTestStateForTest);
afterAll(cleanupPluginLoaderFixturesForTest);

function discoveryFor(...plugins: TempPlugin[]): PluginDiscoveryResult {
  return {
    candidates: plugins.map((plugin) => ({
      idHint: plugin.id,
      rootDir: plugin.dir,
      source: plugin.file,
      origin: "bundled",
    })),
    diagnostics: [],
  };
}

const providerIds = (registry: ReturnType<typeof loadBundledCapabilityRuntimeRegistry>) =>
  registry.providers.map((entry) => entry.provider.id);

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("retains the bundled owner under an external shadow without rediscovering changed manifests", () => {
    const root = makePluginLoaderTempDir();
    const bundledRoot = path.join(root, "bundled");
    const target = writePlugin({
      id: "shadowed-capability",
      dir: path.join(bundledRoot, "shadowed-capability"),
      registration: `api.registerProvider({ id: "bundled-capability", label: "Bundled owner", auth: [] });`,
    });
    fs.writeFileSync(
      path.join(target.dir, "package.json"),
      JSON.stringify({
        name: "@fixture/shadowed-capability",
        openclaw: { extensions: ["./shadowed-capability.cjs"] },
      }),
    );
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
    expect(snapshot.byPluginId.get(target.id)?.origin).toBe("config");
    expect(
      snapshot.bundledManifestRegistry?.plugins.find((plugin) => plugin.id === target.id)?.origin,
    ).toBe("bundled");
    setGatewayPluginMetadataSnapshot(snapshot, { config, env });
    fs.writeFileSync(path.join(target.dir, "openclaw.plugin.json"), "{}");

    const load = (explicit = false) =>
      loadBundledCapabilityRuntimeRegistry({
        pluginIds: [target.id],
        config,
        env,
        ...(explicit && { discovery: discoveryFor(target) }),
      });
    const registry = load();
    expect(providerIds(registry)).toEqual(["bundled-capability"]);
    expect(registry.plugins.find((plugin) => plugin.id === target.id)?.origin).toBe("bundled");
    expect(providerIds(load(true))).toEqual(["bundled-capability"]);
    const freshRegistry = withPluginCache(createPluginCache(), () => load(true));
    expect(freshRegistry.providers).toEqual([]);
    expect(freshRegistry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pluginId: target.id, message: "plugin manifest requires id" }),
      ]),
    );
    expect(providerIds(load())).toEqual(["bundled-capability"]);
  });

  it("loads only the requested bundled plugin without replacing the active registry", () => {
    const target = writePlugin({
      id: "capability-target",
      registration: `if (api.registrationMode === "discovery") {
        api.registerProvider({ id: "capability-target", label: "Target", auth: [] });
      }
      if (api.registrationMode === "full") {
        api.registerProvider({ id: "full-only", label: "Full only", auth: [] });
      }`,
    });
    const unscoped = writePlugin({
      id: "capability-unscoped",
      body: `module.exports = {
        id: "capability-unscoped",
        register() { throw new Error("unscoped plugin loaded"); },
      };`,
    });
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-registry");
    const activeSnapshotBefore = captureActivePluginRegistrySnapshot();
    const registrationContextBefore = getPluginRegistrationContext();

    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [target.id],
      discovery: discoveryFor(target, unscoped),
    });

    expect(registry.plugins.map((plugin) => plugin.id)).toEqual([target.id]);
    expect(registry.plugins[0]?.status).toBe("loaded");
    expect(registry.providers.map((entry) => entry.provider.id)).toEqual([target.id]);
    expect(getActivePluginRegistry()).toBe(active);
    expect(captureActivePluginRegistrySnapshot()).toEqual(activeSnapshotBefore);
    expect(getPluginRegistrationContext()).toBe(registrationContextBefore);
    expect(listImportedRuntimePluginIds()).toContain(target.id);
  });

  it.each([
    {
      name: "explicitly disabled",
      plugins: { entries: { "blocked-capability": { enabled: false } } },
    },
    { name: "denylisted", plugins: { deny: ["blocked-capability"] } },
    { name: "outside the restrictive allowlist", plugins: { allow: ["allowed-capability"] } },
    { name: "blocked by global plugin disablement", plugins: { enabled: false } },
  ])("never imports a $name plugin through bundled capability capture", ({ plugins }) => {
    const blocked = writePlugin({
      id: "blocked-capability",
      registration: `api.registerProvider({ id: "blocked-capability", label: "Blocked", auth: [] });`,
    });

    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [blocked.id],
      config: { plugins },
      discovery: discoveryFor(blocked),
    });

    expect(registry.providers).toEqual([]);
    expect(listImportedRuntimePluginIds()).not.toContain(blocked.id);
  });

  it("registers channel capabilities during discovery without replacing the active registry", () => {
    const target = writePlugin({
      id: "capability-channel",
      registration: `if (api.registrationMode === "discovery") {
        api.registerTranscriptSourceProvider({
          id: "capability-channel-voice", name: "Voice transcripts", sourceKinds: ["meeting"],
        });
      }`,
    });
    fs.writeFileSync(
      path.join(target.dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: target.id,
        channels: [target.id],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-channel-registry");
    const registry = loadBundledCapabilityRuntimeRegistry({
      pluginIds: [target.id],
      discovery: discoveryFor(target),
    });

    const plugin = registry.plugins.find((entry) => entry.id === target.id);
    expect(
      plugin?.status,
      JSON.stringify({ plugin, diagnostics: registry.diagnostics }, null, 2),
    ).toBe("loaded");
    expect(plugin?.transcriptSourceProviderIds).toEqual([`${target.id}-voice`]);
    expect(registry.transcriptSourceProviders.map((entry) => entry.provider.id)).toEqual([
      `${target.id}-voice`,
    ]);
    expect(registry.typedHooks).toEqual([]);
    expect(getActivePluginRegistry()).toBe(active);
  });
});
