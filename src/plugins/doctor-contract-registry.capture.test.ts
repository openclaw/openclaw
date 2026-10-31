import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { collectPluginDoctorStateMigrationPlans } from "../infra/state-migrations.plugin-doctor.js";
import {
  captureRetainedNativeWorkerSource,
  closeDefaultRetainedNativeWorkerSource,
} from "../infra/worker-native-lifecycle.js";
import { preparePluginDoctorContractModules } from "./doctor-contract-preparation.js";
import {
  listPluginDoctorSessionRouteStateOwners,
  listPluginDoctorStateMigrationEntries,
} from "./doctor-contract-registry.js";
import { createDoctorGenerationFixture } from "./doctor-generation.test-support.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  createPluginGenerationMetrics,
  withPluginGenerationMetrics,
} from "./plugin-generation-metrics.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { writeArtifacts as writeTree } from "./public-surface.test-support.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDefaultRetainedNativeWorkerSource();
});

const migrationInput = (root: string) => createDoctorGenerationFixture(root, "fixture").input;

it("prepares manifest-owned session routes without capturing broken runtime source", async () => {
  const rootDir = dirs.make("doctor-manifest-routes-");
  writeTree(rootDir, {
    "package.json": { type: "module" },
    "index.mjs": "this is not valid JavaScript",
    "doctor-contract-api.mjs": "throw new Error('manifest routes must not load this module');",
  });
  const owner = { id: "manifest-owner", label: "Manifest owner" };
  const manifestRegistry = {
    plugins: [
      createPluginManifestRecordFixture({
        id: "manifest-routes",
        rootDir,
        source: path.join(rootDir, "index.mjs"),
        origin: "config",
        doctorContract: { sessionRouteStateOwners: true },
        sessionRouteStateOwners: [owner],
      }),
    ],
    diagnostics: [],
  };
  const metrics = createPluginGenerationMetrics();
  await using cache = createPluginCache();
  await withPluginGenerationMetrics(metrics, () =>
    withPluginCache(cache, async () => {
      await preparePluginDoctorContractModules({
        manifestRegistry,
        surfaces: ["sessionRouteStateOwners"],
      });
      expect(listPluginDoctorSessionRouteStateOwners({ manifestRegistry })).toEqual([owner]);
    }),
  );
  expect(metrics.captures).toBe(0);
  expect(metrics.originalBytes).toBe(0);
});

it("retains direct dependency resource reads for dedicated Doctor callbacks", async () => {
  const rootDir = fs.realpathSync(dirs.make("doctor-dependency-resource-"));
  writeTree(rootDir, {
    "package.json": { type: "module", dependencies: { "data-package": "1.0.0" } },
    "node_modules/data-package/package.json": {
      name: "data-package",
      type: "module",
      main: "index.mjs",
    },
    "node_modules/data-package/index.mjs":
      "throw new Error('resource access must not execute the dependency');",
    "node_modules/data-package/schema.json": { version: "captured-before" },
    "doctor-contract-api.mjs": `import { readFileSync } from 'node:fs';
    export const stateMigrations = [{
      id: 'resource-state', label: 'Dependency resource',
      detectLegacyState() {
        return { preview: [readFileSync(new URL('./node_modules/data-package/schema.json', import.meta.url), 'utf8')] };
      },
      migrateLegacyState() { return { changes: [], warnings: [] }; },
    }];`,
  });
  const record = createPluginManifestRecordFixture({
    id: "resource-fixture",
    rootDir,
    source: path.join(rootDir, "doctor-contract-api.mjs"),
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
  writeTree(rootDir, { "node_modules/data-package/schema.json": { version: "installed-after" } });
  expect(await entry.migration.detectLegacyState(migrationInput(rootDir))).toEqual({
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
  const nativeSource = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  const create = nativeSource.create.bind(nativeSource);
  vi.spyOn(nativeSource, "create").mockImplementation((filename, options = {}, ...rest) =>
    create(
      new URL("./doctor-capture-probe.test-support.ts", import.meta.url),
      {
        ...options,
        workerData: {
          ...options.workerData,
          doctorDependencyLinkFailure: true,
          doctorCaptureWorkerUrl: String(filename),
        },
      },
      ...rest,
    ),
  );
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
  expect(await collected.plans[0]!.migration.migrateLegacyState(migrationInput(roots[1]!))).toEqual(
    { changes: ["healthy migration ran"], warnings: [] },
  );
});
