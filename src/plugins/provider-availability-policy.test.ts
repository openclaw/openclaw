import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { createIndex } from "./manifest-registry-installed.test-helpers.js";
import { loadPluginManifest } from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  projectPluginMetadataSnapshot,
  rebasePluginMetadataSnapshotManifestRegistry,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { resolveProviderManagesOwnAvailability } from "./provider-availability-policy.js";

const tempDirs = createTempDirTracker();
const environment = captureEnv([
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_HOME",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
]);

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
});
afterEach(() => {
  clearRuntimeConfigSnapshot();
  clearPluginMetadataLifecycleCaches();
  environment.restore();
  tempDirs.cleanup();
});

describe("static provider availability ownership", () => {
  it.each(["openrouter", "kilocode"])(
    "keeps the %s capacity declaration in its bundled manifest",
    (provider) => {
      const loaded = loadPluginManifest(path.resolve("extensions", provider), false);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.manifest.providers).toContain(provider);
        expect(loaded.manifest.managesOwnAvailability).toBe(true);
      }
    },
  );

  it.each([true, false, "true", 1, null])("accepts only the boolean declaration %s", (value) => {
    const dir = tempDirs.make("openclaw-provider-availability-");
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "installed",
        providers: ["local"],
        managesOwnAvailability: value,
        configSchema: { type: "object" },
      }),
    );
    const loaded = loadPluginManifest(dir, false);
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.manifest.managesOwnAvailability).toBe(value === true ? true : undefined);
    }
  });

  it("uses cold third-party metadata and the same pinned runtime generation without executing the plugin", async () => {
    const stateDir = tempDirs.make("openclaw-provider-availability-");
    const pluginDir = path.join(stateDir, "extensions", "installed");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      "throw new Error('provider runtime must remain cold');\n",
    );
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "installed",
        providers: ["local"],
        managesOwnAvailability: true,
        configSchema: { type: "object" },
      }),
    );
    const index = createIndex(pluginDir);
    await writePersistedInstalledPluginIndex(index, { stateDir });
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_HOME");
    setTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    deleteTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR");

    const config = {
      plugins: {
        enabled: true,
        allow: ["installed"],
        entries: { installed: { enabled: true } },
        load: { paths: [pluginDir] },
      },
    };
    setRuntimeConfigSnapshot(config, config);
    expect(resolveProviderManagesOwnAvailability("LOCAL")).toBe(true);
    expect(resolveProviderManagesOwnAvailability("unrelated")).toBe(false);
    const snapshot = loadPluginMetadataSnapshot({ config, env: process.env });
    expect(
      withPluginMetadataSnapshotScope(
        snapshot,
        () => resolveProviderManagesOwnAvailability("local"),
        {
          trustConfigIdentity: true,
        },
      ),
    ).toBe(true);
    const empty = projectPluginMetadataSnapshot(snapshot, []);
    expect(
      withPluginMetadataSnapshotScope(empty, () => resolveProviderManagesOwnAvailability("local"), {
        trustConfigIdentity: true,
      }),
    ).toBe(false);
  });

  it("preserves literal owner precedence and excludes disabled declarations", () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "ordinary", providers: ["shared"] },
        { id: "managed", providers: ["shared", "local"], managesOwnAvailability: true },
        { id: "disabled", providers: ["disabled-local"], managesOwnAvailability: true },
      ],
    });
    const prepared = rebasePluginMetadataSnapshotManifestRegistry(
      {
        ...snapshot,
        index: {
          ...snapshot.index,
          plugins: snapshot.index.plugins.map((plugin) => ({
            ...plugin,
            enabled: plugin.pluginId !== "disabled",
          })),
        },
      },
      snapshot.manifestRegistry,
    );
    withPluginMetadataSnapshotScope(
      prepared,
      () => {
        expect(resolveProviderManagesOwnAvailability("shared")).toBe(false);
        expect(resolveProviderManagesOwnAvailability("local")).toBe(true);
        expect(resolveProviderManagesOwnAvailability("disabled-local")).toBe(false);
      },
      { trustConfigIdentity: true },
    );
  });
});
