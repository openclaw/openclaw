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

it.each(["plain", "overlapping package", "native companion", "external dependency junctions"])(
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
    } else if (layout === "external dependency junctions") {
      // Use real filesystem links: Windows junctions are absolute even when
      // capture's dependency producer supplies a relative target.
      const dependencies = dirs.make("doctor-custody-dependencies-");
      const shared = path.join(dependencies, "shared");
      const consumer = path.join(dependencies, "consumer");
      fs.mkdirSync(shared);
      fs.mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
      fs.writeFileSync(
        path.join(shared, "package.json"),
        '{"name":"shared","type":"module","main":"index.mjs"}',
      );
      fs.writeFileSync(path.join(shared, "index.mjs"), 'export const value = "first";');
      fs.writeFileSync(path.join(shared, "resource.txt"), "first");
      fs.writeFileSync(
        path.join(consumer, "package.json"),
        '{"name":"consumer","type":"module","main":"index.mjs","dependencies":{"shared":"1.0.0"}}',
      );
      fs.writeFileSync(
        path.join(consumer, "index.mjs"),
        `import fs from 'node:fs';
         import { value } from 'shared';
         const resource = fs.readFileSync(new URL('./node_modules/shared/resource.txt', import.meta.url), 'utf8');
         export const version = value === resource ? value : 'broken resource';`,
      );
      fs.symlinkSync(shared, path.join(consumer, "node_modules", "shared"), "junction");
      fs.mkdirSync(path.join(plugin.rootDir, "node_modules"));
      fs.symlinkSync(consumer, path.join(plugin.rootDir, "node_modules", "consumer"), "junction");
      fs.symlinkSync(shared, path.join(plugin.rootDir, "node_modules", "shared"), "junction");
      fs.writeFileSync(
        path.join(plugin.rootDir, "package.json"),
        '{"type":"module","dependencies":{"consumer":"1.0.0","shared":"1.0.0"}}',
      );
      fs.writeFileSync(plugin.actions, "export { version } from 'consumer';");
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
