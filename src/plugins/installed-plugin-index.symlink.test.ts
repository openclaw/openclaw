import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifest } from "./manifest.js";
import { readPluginCacheFile } from "./plugin-cache-files.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import { inspectPluginRegistry } from "./plugin-registry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function createAliasedPlugin() {
  const parent = fs.realpathSync(tempDirs.make("plugin-manifest-alias-"));
  const projects = path.join(parent, "projects");
  const root = path.join(projects, "demo");
  const alias = path.join(parent, "alias");
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(projects, alias, process.platform === "win32" ? "junction" : "dir");
  const manifestPath = path.join(root, "openclaw.plugin.json");
  const contents = JSON.stringify({ id: "demo", configSchema: { type: "object" } });
  fs.writeFileSync(manifestPath, contents);
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "@fixture/demo", openclaw: { extensions: ["./index.js"] } }),
  );
  fs.writeFileSync(path.join(root, "index.js"), 'throw new Error("metadata executed runtime");');
  return {
    roots: { canonical: root, alias: path.join(alias, "demo") },
    manifestPath,
    manifestHash: crypto.createHash("sha256").update(contents).digest("hex"),
    env: {
      OPENCLAW_HOME: path.join(parent, "home"),
      OPENCLAW_STATE_DIR: path.join(parent, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  };
}

describe("installed plugin manifest identity", () => {
  it.each([
    { prewarm: undefined, configured: "canonical" },
    { prewarm: undefined, configured: "alias" },
    { prewarm: "alias", configured: "alias" },
    { prewarm: "alias", configured: "canonical" },
    { prewarm: "canonical", configured: "alias" },
  ] as const)("hashes $configured roots after $prewarm prewarming", ({ prewarm, configured }) => {
    const fixture = createAliasedPlugin();
    withPluginCache(createPluginCache(), () => {
      if (prewarm) {
        expect(loadPluginManifest(fixture.roots[prewarm]).ok).toBe(true);
      }
      const index = loadInstalledPluginIndex({
        config: { plugins: { load: { paths: [fixture.roots[configured]] } } },
        env: fixture.env,
        installRecords: {},
      });
      expect(index.plugins).toHaveLength(1);
      expect(index.plugins[0]).toMatchObject({
        rootDir: fixture.roots.canonical,
        manifestPath: fixture.manifestPath,
        manifestHash: fixture.manifestHash,
        manifestFile: { size: fs.statSync(fixture.manifestPath).size },
        packageJson: { path: "package.json" },
      });
      expect(index.diagnostics).toEqual([]);
      for (const root of Object.values(fixture.roots)) {
        expect(loadPluginManifest(root)).toMatchObject({
          ok: true,
          manifestPath: fixture.manifestPath,
        });
      }
    });
  });

  it.each(["contained-symlink", "escaping-symlink", "hardlink", "oversized"] as const)(
    "still rejects %s manifests beneath an aliased root",
    (mode) => {
      const fixture = createAliasedPlugin();
      const target = path.join(
        mode === "escaping-symlink"
          ? path.dirname(fixture.roots.canonical)
          : fixture.roots.canonical,
        "target.json",
      );
      fs.renameSync(fixture.manifestPath, target);
      if (mode === "oversized") {
        fs.writeFileSync(
          fixture.manifestPath,
          JSON.stringify({ id: "demo", pad: "x".repeat(256 * 1024) }),
        );
      } else if (mode === "hardlink") {
        fs.linkSync(target, fixture.manifestPath);
      } else {
        fs.symlinkSync(target, fixture.manifestPath);
      }
      withPluginCache(createPluginCache(), () => {
        if (mode === "hardlink" || mode === "oversized") {
          expect(
            readPluginCacheFile({
              rootDir: fixture.roots.alias,
              relativePath: "openclaw.plugin.json",
              rejectHardlinks: false,
              maxBytes: null,
            }).ok,
          ).toBe(true);
        }
        expect(loadPluginManifest(fixture.roots.alias)).toMatchObject({
          ok: false,
          error: expect.stringContaining("unsafe plugin manifest path"),
        });
      });
    },
  );

  it("repairs persisted empty hashes through the supported registry refresh", async () => {
    const fixture = createAliasedPlugin();
    const params = {
      config: { plugins: { load: { paths: [fixture.roots.alias] } } },
      env: fixture.env,
      stateDir: fixture.env.OPENCLAW_STATE_DIR,
    };
    const broken = withPluginCache(createPluginCache(), () =>
      loadInstalledPluginIndex({ ...params, installRecords: {} }),
    );
    for (const plugin of broken.plugins) {
      plugin.manifestPath = path.join(fixture.roots.alias, "openclaw.plugin.json");
      plugin.manifestHash = "";
      delete plugin.manifestFile;
    }
    writePersistedInstalledPluginIndexSync(broken, params);
    await inspectPluginRegistry(params);
    expect(readPersistedInstalledPluginIndexSync(params)?.plugins[0]?.manifestHash).toBe("");

    await withPluginCache(createPluginCache(), () =>
      refreshPluginRegistry({ ...params, reason: "manual" }),
    );
    closeOpenClawStateDatabaseForTest();
    const persisted = withPluginCache(createPluginCache(), () =>
      readPersistedInstalledPluginIndexSync(params),
    );
    expect(persisted?.plugins[0]).toMatchObject({
      manifestPath: fixture.manifestPath,
      manifestHash: fixture.manifestHash,
      manifestFile: { size: fs.statSync(fixture.manifestPath).size },
    });
    expect(await inspectPluginRegistry(params)).toMatchObject({
      state: "fresh",
      refreshReasons: [],
      differences: [],
    });
  });
});
