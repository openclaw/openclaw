import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { listPluginDoctorStateMigrationEntries } from "./doctor-contract-registry.js";
import { createDoctorGenerationFixture } from "./doctor-generation.test-support.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import * as sourceFiles from "./plugin-source-file.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const write = (root: string, name: string, content: string) =>
  fs.writeFileSync(path.join(root, name), content);

function fixture() {
  const rootDir = dirs.make("doctor-source-custody-");
  const { source, input, inventory } = createDoctorGenerationFixture(rootDir, "custody");
  const actions = path.join(rootDir, "actions.mjs");
  write(rootDir, "package.json", '{"type":"module"}');
  write(rootDir, "asset.txt", "original resource");
  write(rootDir, "actions.mjs", 'export const version = "first";');
  write(
    rootDir,
    "doctor-contract-api.mjs",
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
  const declared = inventory({ stateMigrations: [{ id: "repair" }] });
  const load = () => listPluginDoctorStateMigrationEntries({ inventory: declared })[0]!.migration;
  return { rootDir, source, actions, input, load };
}

it.each(["plain", "overlapping package", "native companion", "external dependency junctions"])(
  "captures unchanged Doctor %s source once with independent callbacks",
  async (layout) => {
    const plugin = fixture();
    if (layout === "overlapping package") {
      const shared = path.join(plugin.rootDir, "shared");
      fs.mkdirSync(shared);
      write(shared, "package.json", '{"main":"index.cjs"}');
      write(shared, "index.cjs", 'module.exports = "shared";');
      fs.mkdirSync(path.join(plugin.rootDir, "node_modules"));
      fs.symlinkSync(shared, path.join(plugin.rootDir, "node_modules", "shared"), "junction");
      write(plugin.rootDir, "package.json", '{"dependencies":{"shared":"*"}}');
    } else if (layout === "external dependency junctions") {
      // Windows junctions are absolute even when capture supplies a relative target.
      const dependencies = dirs.make("doctor-custody-dependencies-");
      const shared = path.join(dependencies, "shared");
      const consumer = path.join(dependencies, "consumer");
      fs.mkdirSync(shared);
      fs.mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
      write(shared, "package.json", '{"main":"index.mjs"}');
      write(shared, "index.mjs", 'export const value = "first";');
      write(shared, "resource.txt", "first");
      write(consumer, "package.json", '{"main":"index.mjs","dependencies":{"shared":"*"}}');
      write(
        consumer,
        "index.mjs",
        `import fs from 'node:fs';
         import { value } from 'shared';
         const resource = fs.readFileSync(new URL('./node_modules/shared/resource.txt', import.meta.url), 'utf8');
         export const version = value === resource ? value : 'broken resource';`,
      );
      fs.symlinkSync(shared, path.join(consumer, "node_modules", "shared"), "junction");
      fs.mkdirSync(path.join(plugin.rootDir, "node_modules"));
      fs.symlinkSync(consumer, path.join(plugin.rootDir, "node_modules", "consumer"), "junction");
      fs.symlinkSync(shared, path.join(plugin.rootDir, "node_modules", "shared"), "junction");
      write(plugin.rootDir, "package.json", '{"dependencies":{"consumer":"*","shared":"*"}}');
      fs.writeFileSync(plugin.actions, "export { version } from 'consumer';");
    } else if (layout === "native companion") {
      write(plugin.rootDir, "a.so", "synthetic native fixture");
      write(plugin.rootDir, "z-helper.dat", "original companion");
    }
    const copies = vi.spyOn(sourceFiles, "copyPluginSourceFile");
    await withPluginGenerationSourceCustody(async () => {
      const results = [];
      const acquisitions: number[] = [];
      for (let phase = 0; phase < 2; phase++) {
        await using cache = createPluginCache();
        results.push(await withPluginCache(cache, plugin.load).migrateLegacyState(plugin.input));
        acquisitions.push(copies.mock.calls.filter(([source]) => source === plugin.source).length);
      }
      expect(results.map((result) => result.changes.slice(0, 3))).toEqual([
        ["first", "1", "original resource"],
        ["first", "1", "original resource"],
      ]);
      expect(results[0]!.changes[3]).not.toBe(results[1]!.changes[3]);
      expect(results.map((result) => result.changes[4])).toEqual(
        layout === "native companion"
          ? ["original companion", "original companion"]
          : ["none", "none"],
      );
      expect(acquisitions[0]).toBeGreaterThan(0);
      expect(acquisitions[1]! - acquisitions[0]!).toBe(0);
    });
  },
);
