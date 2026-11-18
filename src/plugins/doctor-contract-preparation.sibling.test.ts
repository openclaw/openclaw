import fs from "node:fs";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { hasErrnoCode } from "../infra/errno.js";
import { collectPluginDoctorStateMigrationPlans } from "../infra/state-migrations.plugin-doctor.js";
import { closeDefaultRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { resolvePluginDoctorContractArtifact } from "./doctor-contract-artifact.js";
import { listPluginDoctorStateMigrationEntries } from "./doctor-contract-registry.js";
import { createDoctorGenerationFixture } from "./doctor-generation.test-support.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginGenerationSourceCustody } from "./plugin-generation-source-lookup.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import { writeArtifacts } from "./public-surface.test-support.js";

const observed = vi.hoisted(() => ({
  requirePrepared: false,
  synchronousRetries: [] as string[],
  warn: vi.fn(),
}));
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: observed.warn,
    }),
  };
});
vi.mock("./plugin-instance-module-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plugin-instance-module-loader.js")>();
  return {
    ...actual,
    bindPluginInstanceModuleLoader: (
      params: Parameters<typeof actual.bindPluginInstanceModuleLoader>[0],
    ) => {
      if (observed.requirePrepared && !params.preparedArtifact) {
        observed.synchronousRetries.push(params.source);
        throw new Error("Doctor must not retry failed source capture synchronously");
      }
      return actual.bindPluginInstanceModuleLoader(params);
    },
  };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  observed.requirePrepared = false;
  observed.synchronousRetries.length = 0;
  observed.warn.mockClear();
  await closeDefaultRetainedNativeWorkerSource();
});

type SourceFailure = "missing" | "directory" | "hardlink" | "escaping symlink";

function fixture(mode: SourceFailure) {
  const stateDir = dirs.make("doctor-sibling-state-");
  const invalidRoot = dirs.make("doctor-sibling-invalid-");
  const healthyRoot = dirs.make("doctor-sibling-healthy-");
  const invalidSource = path.join(invalidRoot, "doctor-contract-api.mjs");
  writeArtifacts(invalidRoot, {
    "package.json": { type: "module" },
    "doctor-contract-api.mjs": "throw new Error('rejected source must not execute');",
  });
  writeArtifacts(healthyRoot, {
    "package.json": { type: "module" },
    "doctor-contract-api.mjs": `let calls = 0;
      export const stateMigrations = [{ id: 'repair', label: 'Healthy repair',
        detectLegacyState() { return { preview: ['healthy migration'] }; },
        migrateLegacyState() { return { changes: [String(++calls)], warnings: [] }; }
      }];`,
  });
  const records = [
    createPluginManifestRecordFixture({
      id: "invalid-plugin",
      rootDir: invalidRoot,
      source: invalidSource,
      origin: "config",
      doctorContract: { stateMigrations: true },
    }),
    createPluginManifestRecordFixture({
      id: "healthy-plugin",
      rootDir: healthyRoot,
      source: path.join(healthyRoot, "doctor-contract-api.mjs"),
      origin: "config",
      doctorContract: { stateMigrations: [{ id: "repair" }] },
    }),
  ];
  const inventory = {
    records,
    knownPluginIds: records.map((record) => record.id),
    sessionStoreOwnerPluginIds: [],
    descriptors: [{ pluginId: "healthy-plugin", id: "repair" }],
    unresolvedPluginIds: [],
  };
  return {
    stateDir,
    inventory,
    input: createDoctorGenerationFixture(healthyRoot, "healthy-plugin").input,
    rejectSelectedSource() {
      expect(resolvePluginDoctorContractArtifact(records[0]!)).toEqual({
        modulePath: invalidSource,
        boundaryRoot: invalidRoot,
      });
      fs.unlinkSync(invalidSource);
      if (mode === "directory") {
        fs.mkdirSync(invalidSource);
      } else if (mode !== "missing") {
        const outside = path.join(dirs.make("doctor-sibling-outside-"), "outside.mjs");
        fs.writeFileSync(outside, "throw new Error('outside source must not execute');");
        if (mode === "hardlink") {
          fs.linkSync(outside, invalidSource);
        } else {
          fs.symlinkSync(outside, invalidSource);
        }
      }
    },
  };
}

const failureModes: SourceFailure[] = ["missing", "directory", "hardlink", "escaping symlink"];
it.for(failureModes)(
  "keeps the healthy Doctor sibling after selected %s source rejection",
  { timeout: 60_000 },
  async (mode, { skip }) => {
    if (mode === "escaping symlink" && process.platform === "win32") {
      const probe = dirs.make("doctor-sibling-symlink-probe-");
      const target = path.join(probe, "target.mjs");
      fs.writeFileSync(target, "export {}; ");
      try {
        fs.symlinkSync(target, path.join(probe, "alias.mjs"), "file");
      } catch (error) {
        if (hasErrnoCode(error, "EPERM") || hasErrnoCode(error, "EACCES")) {
          skip("Windows host does not grant file-symlink creation");
          return;
        }
        throw error;
      }
    }
    expect(isMainThread, "Doctor sibling proof must use the actual application main thread").toBe(
      true,
    );
    const legacy = fixture(mode);
    await using legacyCache = createPluginCache();
    const legacyEntries = withPluginCache(legacyCache, () => {
      legacy.rejectSelectedSource();
      return listPluginDoctorStateMigrationEntries({ inventory: legacy.inventory });
    });
    expect(legacyEntries.map((entry) => entry.pluginId)).toEqual(["healthy-plugin"]);
    expect(observed.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to load doctor contract for invalid-plugin"),
    );
    observed.warn.mockClear();

    const candidate = fixture(mode);
    await using cache = createPluginCache();
    const collected = await withPluginCache(cache, () => {
      candidate.rejectSelectedSource();
      observed.requirePrepared = true;
      return withArtifactPreservingStateReads(() =>
        withPluginSourceCaptureStorage(
          { stateDir: candidate.stateDir, placement: "temporary" },
          () =>
            withPluginGenerationSourceCustody(() =>
              collectPluginDoctorStateMigrationPlans(candidate.input, {
                inventory: candidate.inventory,
              }),
            ),
        ),
      );
    });
    expect([...collected.inspectedPluginIds]).toEqual(["healthy-plugin"]);
    expect(collected.plans.map((plan) => plan.pluginId)).toEqual(["healthy-plugin"]);
    expect(observed.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to load doctor contract for invalid-plugin"),
    );
    expect(observed.synchronousRetries).toEqual([]);
    expect(await collected.plans[0]!.migration.migrateLegacyState(candidate.input)).toEqual({
      changes: ["1"],
      warnings: [],
    });
  },
);
