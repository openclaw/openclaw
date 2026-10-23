import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, assert, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import { setGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import { writeJson } from "./generated-plugin-test-helpers.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  type TempPlugin,
  writePlugin,
  writePluginMetadata,
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
      registration: `api.registerProvider({ id: "bundled-capability", label: "Bundled owner", auth: [] });`,
    });
    writeJson(path.join(target.dir, "package.json"), {
      name: "@fixture/shadowed-capability",
      openclaw: { extensions: ["./shadowed-capability.cjs"] },
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
    expect(freshRegistry.diagnostics).toContainEqual(
      expect.objectContaining({ pluginId: target.id, message: "plugin manifest requires id" }),
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
      registration: `throw new Error("unscoped plugin loaded");`,
    });
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-registry");
    const activeSnapshotBefore = captureActivePluginRegistrySnapshot();
    const registrationContextBefore = getPluginRegistrationContext();

    const registry = capture(target, [unscoped]);

    expect(registry.plugins).toMatchObject([{ id: target.id, status: "loaded" }]);
    expect(providerIds(registry)).toEqual([target.id]);
    expect(getActivePluginRegistry()).toBe(active);
    expect(captureActivePluginRegistrySnapshot()).toEqual(activeSnapshotBefore);
    expect(getPluginRegistrationContext()).toBe(registrationContextBefore);
    expect(listImportedRuntimePluginIds()).toContain(target.id);
  });

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

    const registry = capture(blocked, [], { plugins });

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
    writePluginMetadata({ dir: target.dir, id: target.id, channels: [target.id] });
    const active = createEmptyPluginRegistry();
    setActivePluginRegistry(active, "existing-channel-registry");
    const registry = capture(target);
    expect(registry.plugins.find((entry) => entry.id === target.id)).toMatchObject({
      status: "loaded",
      transcriptSourceProviderIds: [`${target.id}-voice`],
    });
    expect(registry.transcriptSourceProviders.map((entry) => entry.provider.id)).toEqual([
      `${target.id}-voice`,
    ]);
    expect(registry.typedHooks).toEqual([]);
    expect(getActivePluginRegistry()).toBe(active);
  });
});
