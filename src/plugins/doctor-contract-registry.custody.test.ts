import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { preparePluginDoctorContractModules } from "./doctor-contract-preparation.js";
import { listPluginDoctorStateMigrationEntries } from "./doctor-contract-registry.js";
import { createDoctorGenerationFixture } from "./doctor-generation.test-support.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
function fixture() {
  const rootDir = dirs.make("doctor-source-custody-");
  const { source, input, inventory } = createDoctorGenerationFixture(rootDir, "custody");
  const actions = path.join(rootDir, "actions.mjs");
  writeArtifacts(rootDir, {
    "package.json": { type: "module" },
    "asset.txt": "original resource",
    "actions.mjs": 'export const version = "first";',
    "doctor-contract-api.mjs": `import fs from "node:fs";
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
  });
  const declared = inventory({ stateMigrations: [{ id: "repair" }] });
  const load = async () => {
    await preparePluginDoctorContractModules({ inventory: declared });
    return listPluginDoctorStateMigrationEntries({ inventory: declared })[0]!.migration;
  };
  return { rootDir, source, actions, input, load };
}

it.each(["plain", "overlapping package", "native companion", "external dependency junctions"])(
  "captures unchanged Doctor %s source once with independent callbacks",
  async (layout) => {
    const plugin = fixture();
    if (layout === "overlapping package") {
      const shared = path.join(plugin.rootDir, "shared");
      writeArtifacts(shared, {
        "package.json": { main: "index.cjs" },
        "index.cjs": 'module.exports = "shared";',
      });
      fs.mkdirSync(path.join(plugin.rootDir, "node_modules"));
      fs.symlinkSync(shared, path.join(plugin.rootDir, "node_modules", "shared"), "junction");
      writeArtifacts(plugin.rootDir, { "package.json": { dependencies: { shared: "*" } } });
    } else if (layout === "external dependency junctions") {
      // Windows junctions are absolute even when capture supplies a relative target.
      const dependencies = dirs.make("doctor-custody-dependencies-");
      const shared = path.join(dependencies, "shared");
      const consumer = path.join(dependencies, "consumer");
      writeArtifacts(shared, {
        "package.json": { main: "index.mjs" },
        "index.mjs": 'export const value = "first";',
        "resource.txt": "first",
      });
      fs.mkdirSync(path.join(consumer, "node_modules"), { recursive: true });
      writeArtifacts(consumer, {
        "package.json": { main: "index.mjs", dependencies: { shared: "*" } },
        "index.mjs": `import fs from 'node:fs';
         import { value } from 'shared';
         const resource = fs.readFileSync(new URL('./node_modules/shared/resource.txt', import.meta.url), 'utf8');
         export const version = value === resource ? value : 'broken resource';`,
      });
      fs.symlinkSync(shared, path.join(consumer, "node_modules", "shared"), "junction");
      fs.mkdirSync(path.join(plugin.rootDir, "node_modules"));
      fs.symlinkSync(consumer, path.join(plugin.rootDir, "node_modules", "consumer"), "junction");
      fs.symlinkSync(shared, path.join(plugin.rootDir, "node_modules", "shared"), "junction");
      writeArtifacts(plugin.rootDir, {
        "package.json": { dependencies: { consumer: "*", shared: "*" } },
      });
      fs.writeFileSync(plugin.actions, "export { version } from 'consumer';");
    } else if (layout === "native companion") {
      writeArtifacts(plugin.rootDir, {
        "a.so": "synthetic native fixture",
        "z-helper.dat": "original companion",
      });
    }
    const digests: Array<string | undefined> = [];
    const metrics = createPluginGenerationMetrics();
    const originalBytes: number[] = [];
    const nativeReferenceBytes =
      layout === "native companion" ? fs.statSync(path.join(plugin.rootDir, "a.so")).size : 0;
    await withPluginGenerationMetrics(metrics, () =>
      withPluginGenerationSourceCustody(async () => {
        const results = [];
        for (let phase = 0; phase < 2; phase++) {
          await using cache = createPluginCache();
          results.push(
            await withPluginCache(cache, async () =>
              (await plugin.load()).migrateLegacyState(plugin.input),
            ),
          );
          digests.push([...cache.setupModules.values()][0]!.sourceDigest);
          originalBytes.push(metrics.originalBytes);
        }
        expect(results.map((result) => result.changes.slice(0, 3))).toEqual(
          Array.from({ length: 2 }, () => ["first", "1", "original resource"]),
        );
        expect(results[0]!.changes[3]).not.toBe(results[1]!.changes[3]);
        const companion = layout === "native companion" ? "original companion" : "none";
        expect(results.map((result) => result.changes[4])).toEqual([companion, companion]);
      }),
    );
    expect(originalBytes[0]).toBeGreaterThan(0);
    // Fresh native admission still selects its reference; ordinary captured bytes stay reused.
    expect(originalBytes[1]).toBe(originalBytes[0]! + nativeReferenceBytes);
    expect(digests[0]).toBe(digests[1]);
    fs.writeFileSync(plugin.actions, 'export const version = "changed after capture";');
    await withPluginGenerationSourceCustody(async () => {
      await using cache = createPluginCache();
      const result = await withPluginCache(cache, async () =>
        (await plugin.load()).migrateLegacyState(plugin.input),
      );
      expect(result.changes.slice(0, 3)).toEqual([
        "changed after capture",
        "1",
        "original resource",
      ]);
      expect([...cache.setupModules.values()][0]!.sourceDigest).not.toBe(digests[0]);
    });
  },
);
