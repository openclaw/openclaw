import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectPluginDoctorStateMigrationPlans } from "../infra/state-migrations.plugin-doctor.js";
import { listPluginDoctorStateMigrationEntries } from "./doctor-contract-registry.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function writeTree(root: string, files: Record<string, string | Record<string, unknown>>) {
  for (const [name, value] of Object.entries(files)) {
    const filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  }
}

it("retains direct dependency resource reads for dedicated Doctor callbacks", async () => {
  const rootDir = fs.realpathSync(dirs.make("doctor-dependency-resource-"));
  const write = (name: string, body: string) => {
    const filename = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, body);
    return filename;
  };
  write(
    "package.json",
    JSON.stringify({ type: "module", dependencies: { "data-package": "1.0.0" } }),
  );
  write(
    "node_modules/data-package/package.json",
    JSON.stringify({ name: "data-package", type: "module", main: "index.mjs" }),
  );
  write(
    "node_modules/data-package/index.mjs",
    "throw new Error('resource access must not execute the dependency');",
  );
  write("node_modules/data-package/schema.json", '{"version":"captured-before"}');
  const source = write(
    "doctor-contract-api.mjs",
    `import { readFileSync } from 'node:fs';
    export const stateMigrations = [{
      id: 'resource-state', label: 'Dependency resource',
      detectLegacyState() {
        return { preview: [readFileSync(new URL('./node_modules/data-package/schema.json', import.meta.url), 'utf8')] };
      },
      migrateLegacyState() { return { changes: [], warnings: [] }; },
    }];`,
  );
  const record = createPluginManifestRecordFixture({
    id: "resource-fixture",
    rootDir,
    source,
    origin: "config",
    doctorContract: { stateMigrations: [{ id: "resource-state" }] },
  });
  await using cache = createPluginCache();
  const entries = withPluginCache(cache, () =>
    listPluginDoctorStateMigrationEntries({
      manifestRegistry: { plugins: [record], diagnostics: [] },
    }),
  );
  const entry = expectDefined(entries[0], "dedicated Doctor migration");
  write("node_modules/data-package/schema.json", '{"version":"installed-after"}');
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
  expect(await entry.migration.detectLegacyState(input)).toEqual({
    preview: ['{"version":"captured-before"}'],
  });
});

it("keeps other plugin migrations available after a dependency link cannot be created", async () => {
  const roots = [dirs.make("doctor-link-failure-"), dirs.make("doctor-link-healthy-")];
  const dependency = dirs.make("doctor-link-dependency-");
  writeTree(dependency, {
    "package.json": { name: "broken-dependency", main: "index.cjs" },
    "index.cjs": "module.exports = true;",
  });
  const records = roots.map((rootDir, index) => {
    writeTree(rootDir, {
      "package.json": {
        type: "module",
        ...(index === 0 ? { dependencies: { "broken-dependency": "*" } } : {}),
      },
      "doctor-contract-api.mjs": `export const stateMigrations = [{
        id: 'repair', label: 'Repair fixture',
        detectLegacyState() { return { preview: ['fixture'] }; },
        migrateLegacyState() { return { changes: ['healthy migration ran'], warnings: [] }; }
      }];`,
    });
    return createPluginManifestRecordFixture({
      id: index === 0 ? "unprepared-plugin" : "healthy-plugin",
      rootDir,
      source: path.join(rootDir, "doctor-contract-api.mjs"),
      origin: "config",
      doctorContract: { stateMigrations: [{ id: "repair" }] },
    });
  });
  fs.mkdirSync(path.join(roots[0]!, "node_modules"));
  fs.symlinkSync(dependency, path.join(roots[0]!, "node_modules", "broken-dependency"), "junction");
  const symlink = fs.symlinkSync;
  vi.spyOn(fs, "symlinkSync").mockImplementation((destination, filename, type) => {
    if (
      String(filename).includes("openclaw-plugin-build-") &&
      path.basename(String(filename)).startsWith("broken-dependency")
    ) {
      throw Object.assign(new Error("fixture dependency link permission denied"), {
        code: "EACCES",
      });
    }
    symlink(destination, filename, type);
  });
  const warnings: string[] = [];
  await using cache = createPluginCache();
  const collected = await withPluginCache(cache, () =>
    collectPluginDoctorStateMigrationPlans(
      { config: {}, env: {}, stateDir: roots[1]!, oauthDir: roots[1]! },
      {
        inventory: {
          records,
          knownPluginIds: records.map((record) => record.id),
          descriptors: records.map((record) => ({ pluginId: record.id, id: "repair" })),
          sessionStoreOwnerPluginIds: [],
          unresolvedPluginIds: [],
        },
        plannedActions: records.map((record) => ({ pluginId: record.id, id: "repair" })),
        warnings,
      },
    ),
  );
  expect([...collected.inspectedPluginIds]).toEqual(["healthy-plugin"]);
  expect(collected.requiredPluginIds).toEqual(new Set(["unprepared-plugin", "healthy-plugin"]));
  expect(collected.plans.map((plan) => plan.pluginId)).toEqual(["healthy-plugin"]);
  expect(warnings).toEqual([expect.stringContaining("Plugin unprepared-plugin is not prepared")]);
  expect(
    await collected.plans[0]!.migration.migrateLegacyState({
      config: {},
      env: {},
      stateDir: roots[1]!,
      oauthDir: roots[1]!,
      context: {
        openPluginStateKeyedStore() {
          throw new Error("fixture must not open state");
        },
      },
    }),
  ).toEqual({ changes: ["healthy migration ran"], warnings: [] });
});
