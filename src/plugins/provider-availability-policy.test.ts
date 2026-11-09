import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { createIndex } from "./manifest-registry-installed.test-helpers.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  rebasePluginMetadataSnapshotManifestRegistry as rebaseRegistry,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveProviderManagesOwnAvailability as managesAvailability } from "./provider-availability-policy.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const tempDirs = createTempDirTracker();

function writeManifest(directory: string, managesOwnAvailability: unknown) {
  writeArtifacts(directory, {
    "openclaw.plugin.json": {
      id: "installed",
      providers: ["local"],
      managesOwnAvailability,
      configSchema: { type: "object" },
    },
  });
}

function within<T>(snapshot: Parameters<typeof withPluginMetadataSnapshotScope>[0], run: () => T) {
  return withPluginMetadataSnapshotScope(snapshot, run, { trustConfigIdentity: true });
}

function clearCaches() {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
}
beforeEach(clearCaches);
afterEach(() => {
  clearCaches();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

it.each(["openrouter", "kilocode"])(
  "keeps the %s capacity declaration in its bundled manifest",
  (provider) => {
    expect(loadPluginManifest(path.resolve("extensions", provider), false)).toMatchObject({
      ok: true,
      manifest: { providers: expect.arrayContaining([provider]), managesOwnAvailability: true },
    });
  },
);

it.each([false, "true"])("rejects non-enabled availability declaration %s", (value) => {
  const dir = tempDirs.make("openclaw-provider-availability-");
  writeManifest(dir, value);
  const loaded = loadPluginManifest(dir, false);
  expect(loaded.ok && loaded.manifest.managesOwnAvailability).toBeUndefined();
});

it("uses cold third-party metadata and the same pinned runtime generation without executing the plugin", async () => {
  const stateDir = tempDirs.make("openclaw-provider-availability-");
  const pluginDir = path.join(stateDir, "extensions", "installed");
  writeArtifacts(pluginDir, {
    "index.js": "throw new Error('provider runtime must remain cold');",
  });
  writeManifest(pluginDir, true);
  await writePersistedInstalledPluginIndex(createIndex(pluginDir), { stateDir });
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_HOME", undefined);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", undefined);

  const config = { plugins: { allow: ["installed"], load: { paths: [pluginDir] } } };
  setRuntimeConfigSnapshot(config, config);
  expect([managesAvailability("LOCAL"), managesAvailability("unrelated")]).toEqual([true, false]);
  const snapshot = loadPluginMetadataSnapshot({ config, env: process.env });
  expect(within(snapshot, () => managesAvailability("local"))).toBe(true);
  const empty = projectPluginMetadataSnapshot(snapshot, []);
  expect(within(empty, () => managesAvailability("local"))).toBe(false);
});

it("preserves literal owner precedence and excludes disabled declarations", () => {
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      { id: "ordinary", providers: ["shared"] },
      { id: "managed", providers: ["shared", "local"], managesOwnAvailability: true },
      { id: "disabled", providers: ["disabled-local"], managesOwnAvailability: true },
    ],
  });
  for (const plugin of snapshot.index.plugins) {
    plugin.enabled = plugin.pluginId !== "disabled";
  }
  const prepared = rebaseRegistry(snapshot, snapshot.manifestRegistry);
  within(prepared, () => {
    expect(["shared", "local", "disabled-local"].map(managesAvailability)).toEqual([
      false,
      true,
      false,
    ]);
  });
});
