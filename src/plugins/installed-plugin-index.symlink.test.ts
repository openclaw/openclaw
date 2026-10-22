import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { readPersistedInstalledPluginIndexSync } from "./installed-plugin-index-store.js";
import { loadInstalledPluginIndex } from "./installed-plugin-index.js";
import { loadPluginManifest } from "./manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { refreshPluginRegistry } from "./plugin-registry-refresh.js";
import { inspectPluginRegistry } from "./plugin-registry.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);
const freshCache = <T>(read: () => T) => withPluginCache(createPluginCache(), read);

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
    identity: {
      manifestPath,
      manifestHash: crypto.createHash("sha256").update(contents).digest("hex"),
      manifestFile: { size: fs.statSync(manifestPath).size },
    },
    env: {
      OPENCLAW_HOME: path.join(parent, "home"),
      OPENCLAW_STATE_DIR: path.join(parent, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  };
}

it.each([
  { prewarm: "alias", configured: "canonical" },
  { prewarm: "canonical", configured: "alias" },
] as const)("hashes $configured roots after $prewarm prewarming", ({ prewarm, configured }) => {
  const { roots, identity, manifestPath, env } = createAliasedPlugin();
  freshCache(() => {
    expect(loadPluginManifest(roots[prewarm]).ok).toBe(true);
    const index = loadInstalledPluginIndex({
      config: { plugins: { load: { paths: [roots[configured]] } } },
      env,
      installRecords: {},
    });
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0]).toMatchObject({
      rootDir: roots.canonical,
      ...identity,
      packageJson: { path: "package.json" },
    });
    expect(index.diagnostics).toEqual([]);
    for (const root of Object.values(roots)) {
      expect(loadPluginManifest(root)).toMatchObject({
        ok: true,
        manifestPath,
      });
    }
  });
});

it("still rejects manifest symlinks beneath an aliased root", () => {
  const { roots, manifestPath } = createAliasedPlugin();
  const target = path.join(roots.canonical, "target.json");
  fs.renameSync(manifestPath, target);
  fs.symlinkSync(target, manifestPath);
  freshCache(() => {
    expect(loadPluginManifest(roots.alias)).toMatchObject({
      ok: false,
      error: expect.stringContaining("unsafe plugin manifest path"),
    });
  });
});

it("repairs persisted empty hashes through the supported registry refresh", async () => {
  const fixture = createAliasedPlugin();
  const params = {
    config: { plugins: { load: { paths: [fixture.roots.alias] } } },
    env: fixture.env,
    stateDir: fixture.env.OPENCLAW_STATE_DIR,
  };
  const broken = freshCache(() => loadInstalledPluginIndex({ ...params, installRecords: {} }));
  for (const plugin of broken.plugins) {
    plugin.manifestPath = path.join(fixture.roots.alias, "openclaw.plugin.json");
    plugin.manifestHash = "";
    delete plugin.manifestFile;
  }
  await writePersistedInstalledPluginIndex(broken, params);
  await inspectPluginRegistry(params);
  expect(readPersistedInstalledPluginIndexSync(params)?.plugins[0]?.manifestHash).toBe("");

  await freshCache(() => refreshPluginRegistry({ ...params, reason: "manual" }));
  await closeStateDatabaseForTest();
  const persisted = freshCache(() => readPersistedInstalledPluginIndexSync(params));
  expect(persisted?.plugins[0]).toMatchObject(fixture.identity);
  expect(await inspectPluginRegistry(params)).toMatchObject({
    state: "fresh",
    refreshReasons: [],
    differences: [],
  });
});
