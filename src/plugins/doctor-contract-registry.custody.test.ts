import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listPluginDoctorStateMigrationEntries } from "./doctor-contract-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import * as sourceFiles from "./plugin-source-file.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const rootDir = dirs.make("doctor-source-custody-");
  const source = path.join(rootDir, "doctor-contract-api.mjs");
  const asset = path.join(rootDir, "asset.txt");
  const actions = path.join(rootDir, "actions.mjs");
  fs.writeFileSync(path.join(rootDir, "package.json"), '{"type":"module"}');
  fs.writeFileSync(asset, "original resource");
  fs.writeFileSync(actions, 'export const version = "first";');
  fs.writeFileSync(
    source,
    `import fs from "node:fs";
     import { version } from ${JSON.stringify(pathToFileURL(actions).href)};
     let calls = 0;
     export const stateMigrations = [{
       id: "repair", label: "repair",
       detectLegacyState() { return { preview: [version] }; },
       migrateLegacyState() {
         const asset = new URL("./asset.txt", import.meta.url);
         const resource = fs.readFileSync(asset, "utf8");
         fs.writeFileSync(asset, "changed by callback");
         const companion = new URL("./z-helper.dat", import.meta.url);
         return { changes: [version, String(++calls), resource, import.meta.url,
           fs.existsSync(companion) ? fs.readFileSync(companion, "utf8") : "none"], warnings: [] };
       }
     }];`,
  );
  const inventory = {
    records: [
      createPluginManifestRecordFixture({
        id: "custody",
        rootDir,
        source,
        origin: "global",
        doctorContract: { stateMigrations: [{ id: "repair" }] },
      }),
    ],
    knownPluginIds: ["custody"],
    sessionStoreOwnerPluginIds: [],
    descriptors: [],
    unresolvedPluginIds: [],
  };
  const input = {
    config: {},
    env: {},
    stateDir: rootDir,
    oauthDir: rootDir,
    context: {
      openPluginStateKeyedStore() {
        throw new Error("fixture must not open state");
      },
    },
  };
  const load = () => listPluginDoctorStateMigrationEntries({ inventory })[0]!.migration;
  return { rootDir, source, actions, input, load };
}

it.each(["plain", "overlapping package", "native companion"])(
  "captures unchanged Doctor %s source once with independent callbacks",
  async (layout) => {
    const plugin = fixture();
    if (layout === "overlapping package") {
      const shared = path.join(plugin.rootDir, "shared");
      fs.mkdirSync(shared);
      fs.writeFileSync(path.join(shared, "package.json"), '{"name":"shared","main":"index.cjs"}');
      fs.writeFileSync(path.join(shared, "index.cjs"), 'module.exports = "shared";');
      fs.mkdirSync(path.join(plugin.rootDir, "node_modules"));
      fs.symlinkSync(shared, path.join(plugin.rootDir, "node_modules", "shared"), "junction");
      fs.writeFileSync(
        path.join(plugin.rootDir, "package.json"),
        '{"type":"module","dependencies":{"shared":"1.0.0"}}',
      );
    } else if (layout === "native companion") {
      fs.writeFileSync(path.join(plugin.rootDir, "a.so"), "synthetic native fixture");
      fs.writeFileSync(path.join(plugin.rootDir, "z-helper.dat"), "original companion");
    }
    const copies = vi.spyOn(sourceFiles, "copyPluginSourceFile");
    await withPluginGenerationSourceCustody(async () => {
      const results = [];
      const acquisitions: number[] = [];
      for (let phase = 0; phase < 2; phase++) {
        await using cache = createPluginCache();
        const migration = withPluginCache(cache, plugin.load);
        results.push(await migration.migrateLegacyState(plugin.input));
        acquisitions.push(copies.mock.calls.filter(([source]) => source === plugin.source).length);
      }
      expect(results.map((result) => result.changes.slice(0, 3))).toEqual([
        ["first", "1", "original resource"],
        ["first", "1", "original resource"],
      ]);
      expect(results[0]!.changes[3]).not.toBe(results[1]!.changes[3]);
      expect(acquisitions[0]).toBeGreaterThan(0);
      expect(acquisitions[1]! - acquisitions[0]!).toBe(0);
    });
  },
);

it.each(["content", "root", "native companion"])(
  "recaptures changed %s without changing old callbacks",
  async (change) => {
    const plugin = fixture();
    if (change === "native companion") {
      fs.writeFileSync(path.join(plugin.rootDir, "a.so"), "synthetic native fixture");
      fs.writeFileSync(path.join(plugin.rootDir, "z-helper.dat"), "original companion");
    }
    const copies = vi.spyOn(sourceFiles, "copyPluginSourceFile");
    await withPluginGenerationSourceCustody(async () => {
      await using firstCache = createPluginCache();
      const first = withPluginCache(firstCache, plugin.load);
      if (change === "root") {
        const moved = path.join(dirs.make("doctor-replaced-source-"), "old");
        fs.renameSync(plugin.rootDir, moved);
        fs.cpSync(moved, plugin.rootDir, { recursive: true });
      }
      if (change === "native companion") {
        fs.writeFileSync(path.join(plugin.rootDir, "z-helper.dat"), "changed companion");
      } else {
        fs.writeFileSync(plugin.actions, 'export const version = "second";');
      }
      await using secondCache = createPluginCache();
      const second = withPluginCache(secondCache, plugin.load);
      const previous = await first.migrateLegacyState(plugin.input);
      const current = await second.migrateLegacyState(plugin.input);
      expect(previous.changes.slice(0, 3)).toEqual(["first", "1", "original resource"]);
      expect(current.changes.slice(0, 3)).toEqual([
        change === "native companion" ? "first" : "second",
        "1",
        "original resource",
      ]);
      if (change === "native companion") {
        expect([previous.changes[4], current.changes[4]]).toEqual([
          "original companion",
          "changed companion",
        ]);
      }
      expect(copies.mock.calls.filter(([source]) => source === plugin.source)).toHaveLength(2);
    });
  },
);

it.each(["removed", "retargeted"])(
  "recaptures a %s optional dependency while its old files still exist",
  async (change) => {
    const plugin = fixture();
    const dependency = (value: string) => {
      const root = dirs.make("doctor-optional-package-");
      fs.writeFileSync(path.join(root, "package.json"), '{"name":"optional","main":"index.cjs"}');
      fs.writeFileSync(path.join(root, "index.cjs"), `module.exports = ${JSON.stringify(value)};`);
      return root;
    };
    const oldRoot = dependency("old dependency");
    const newRoot = dependency("new dependency");
    const modules = path.join(plugin.rootDir, "node_modules");
    fs.mkdirSync(modules);
    const link = path.join(modules, "optional");
    fs.symlinkSync(oldRoot, link, "junction");
    fs.writeFileSync(
      path.join(plugin.rootDir, "package.json"),
      '{"type":"module","optionalDependencies":{"optional":"1.0.0"}}',
    );
    fs.writeFileSync(
      plugin.source,
      `
    import { createRequire } from "node:module";
    const require = createRequire(import.meta.url);
    export const stateMigrations = [{
      id: "repair", label: "repair", detectLegacyState() { return { preview: [] }; },
      migrateLegacyState() {
        let value;
        try { value = require("optional"); } catch { value = "missing dependency"; }
        return { changes: [value], warnings: [] };
      }
    }];
  `,
    );
    await withPluginGenerationSourceCustody(async () => {
      await using firstCache = createPluginCache();
      const first = withPluginCache(firstCache, plugin.load);
      fs.unlinkSync(link);
      if (change === "retargeted") {
        fs.symlinkSync(newRoot, link, "junction");
      }
      await using secondCache = createPluginCache();
      const second = withPluginCache(secondCache, plugin.load);
      expect((await first.migrateLegacyState(plugin.input)).changes).toEqual(["old dependency"]);
      expect((await second.migrateLegacyState(plugin.input)).changes).toEqual([
        change === "retargeted" ? "new dependency" : "missing dependency",
      ]);
    });
  },
);
