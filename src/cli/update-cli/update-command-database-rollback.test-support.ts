import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { resolveSqliteSchemaAssetInputs } from "../../../scripts/lib/sqlite-schema-assets.mts";
import { vitestWorkerRuntimeAssets } from "../../../scripts/lib/vitest-worker-declarations.mts";
import { withPluginCohortConfigCapture } from "../../config/plugin-cohort-recovery.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { recordDeferredPluginMigrations } from "../../infra/deferred-plugin-migrations.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { pluginCohortPublicationContext } from "../../infra/update-plugin-cohort-context.js";
import { loadPluginCohortRecovery } from "../../infra/update-run-recovery-store.js";
import { createCompiledSdkHost } from "../../plugins/compiled-sdk-host.test-support.js";
import {
  readPersistedInstalledPluginIndexRowSync,
  seedInstalledPluginIndex,
} from "../../plugins/test-helpers/installed-plugin-index.js";
import { registerOpenClawAgentDatabase } from "../../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import type { UpdateCommandOptions } from "./shared.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";

/** Resolve after the execution fixture has loaded its native worker owners. */
export function resolveRollbackWorkerInputs() {
  const gatewayLockUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.gatewayLock);
  const databaseGenerationsUrl = resolveRuntimeWorkerUrl(
    updateExecutorNativeEntrypoints.databaseGenerations,
  );
  const sourceLoader = gatewayLockUrl.pathname.endsWith(".ts")
    ? `process.env.TSX_TSCONFIG_PATH=${JSON.stringify(fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)))};
     await import(${JSON.stringify(new URL("../../../scripts/tsx.mjs", import.meta.url).href)});`
    : "";
  return { gatewayLockUrl, databaseGenerationsUrl, sourceLoader };
}

/** Keep settlement on the real candidate's delegated native owner. */
export async function prepareRollbackRuntime(root: string): Promise<string> {
  const installed = createCompiledSdkHost(
    [
      runtimeProcessEntrypoints.updateMigratedFinalize,
      runtimeProcessEntrypoints.workerNativeLifecycle,
      runtimeProcessEntrypoints.sqliteWriterAdmission,
      runtimeProcessEntrypoints.sqliteStore,
      runtimeProcessEntrypoints.sqliteIntegrity,
      runtimeProcessEntrypoints.sqliteReadOnly,
      runtimeProcessEntrypoints.sqliteReadOnlyNativeResource,
      runtimeProcessEntrypoints.sqliteSnapshotStaging,
      runtimeProcessEntrypoints.sqliteSourceRevision,
      runtimeProcessEntrypoints.sharedStateStore,
      runtimeProcessEntrypoints.stateOwnership,
      runtimeProcessEntrypoints.stateLeaseHeartbeat,
      runtimeProcessEntrypoints.stateRead,
    ],
    () => root,
  );
  if (!installed) {
    throw new Error("Database rollback fixture requires the compiled candidate worker generation");
  }
  // The fixture supplies dependencies from its common stage/live ancestor;
  // no checkout symlink belongs in either retained package identity.
  await fs.unlink(path.join(root, "node_modules"));
  const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateMigratedFinalize);
  const generationRoot = path.resolve(path.dirname(fileURLToPath(worker)), "../..");
  for (const asset of vitestWorkerRuntimeAssets) {
    await fs.copyFile(path.join(generationRoot, asset), path.join(root, asset));
  }
  for (const asset of resolveSqliteSchemaAssetInputs()) {
    const relative = path.join("dist", "assets", "sqlite-schema", path.basename(asset));
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.copyFile(path.join(generationRoot, relative), path.join(root, relative));
  }
  const actual = path.join(root, "dist/infra/update-migrated-finalize.actual.js");
  await fs.copyFile(
    path.join(root, "dist", runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath),
    actual,
  );
  return "./update-migrated-finalize.actual.js";
}

export async function createRollbackDatabases(params: {
  env: NodeJS.ProcessEnv;
  shared: string;
  agent: string;
  sharedVersion?: number;
}): Promise<void> {
  openOpenClawStateDatabase({ env: params.env });
  await closeOpenClawStateDatabaseAsync();
  for (const [file, version] of [
    [params.shared, params.sharedVersion ?? 15],
    [params.agent, 21],
  ] as const) {
    using db = new DatabaseSync(file);
    db.exec(
      `PRAGMA user_version=${version}; CREATE TABLE payload(value TEXT); INSERT INTO payload(rowid,value) VALUES(7,'first'),(42,'retained');`,
    );
    if (file === params.shared) {
      // Test-only publication floors on canonical layout, not an old published database fixture.
      db.prepare("UPDATE schema_meta SET schema_version=? WHERE meta_key='primary'").run(version);
    }
  }
  registerOpenClawAgentDatabase({
    agentId: "main",
    path: params.agent,
    schemaVersion: 21,
    env: params.env,
  });
  await closeOpenClawStateDatabaseAsync();
}

/**
 * Leaves `database` as a writer that exited just before capture would: a WAL family
 * with both sidecars and no holder. Copying it while open keeps the visible rows.
 */
export async function leaveExitedWriterWalFamily(database: string, scratch: string) {
  await fs.mkdir(scratch);
  {
    using writer = new DatabaseSync(database);
    writer.exec(
      "PRAGMA journal_mode=WAL; INSERT INTO payload(rowid,value) VALUES(1000,'transient'); DELETE FROM payload WHERE rowid=1000;",
    );
    for (const suffix of ["", "-wal", "-shm"]) {
      await fs.copyFile(`${database}${suffix}`, path.join(scratch, suffix || "db"));
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    await fs.copyFile(path.join(scratch, suffix || "db"), `${database}${suffix}`);
  }
}

export function readDatabase(file: string) {
  using db = new DatabaseSync(file, { readOnly: true });
  return {
    version: db.prepare("PRAGMA user_version").get()?.user_version,
    rows: db.prepare("SELECT rowid, value FROM payload ORDER BY rowid").all(),
    columns: db
      .prepare("PRAGMA table_info(payload)")
      .all()
      .map((column) => column.name),
  };
}

export const readVersion = async (root: string) =>
  JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")).version;
export const candidateRows = [
  { rowid: 7, value: "candidate" },
  { rowid: 42, value: "candidate" },
];

/** Observe a real outside install without attributing it to the update's publication context. */
export function createIndependentPluginRollbackWitness({
  stateDir,
  env,
  config,
  mode = "index",
}: {
  stateDir: string;
  env: NodeJS.ProcessEnv;
  config: OpenClawConfig;
  mode?: "index" | "migration";
}) {
  const independentPath = path.join(stateDir, "extensions/independent");
  const independentRecord = {
    source: "npm" as const,
    spec: "@example/independent@1.0.0",
    version: "1.0.0",
    installPath: independentPath,
  };
  const independentRecords = () => {
    const row = readPersistedInstalledPluginIndexRowSync({
      env,
      artifactPreservingReadOnly: true,
    });
    return row ? (JSON.parse(row.value_json).index.installRecords ?? {}) : {};
  };
  const writeJson = (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value));
  const obligation = {
    pluginId: "independent",
    reason: "baseline decision A",
    command: "openclaw doctor --fix",
    requiresStateMigration: true as const,
  };
  const readMigration = () => {
    using db = new DatabaseSync(path.join(stateDir, "state/openclaw.sqlite"), { readOnly: true });
    return db
      .prepare("SELECT id,started_at,finished_at,status,report_json FROM migration_runs WHERE id=?")
      .get("deferred-plugin-migration:independent");
  };
  let independentMigration: ReturnType<typeof readMigration>;
  return {
    async seedBaseline() {
      if (mode === "migration") {
        await recordDeferredPluginMigrations({ env, pending: [obligation] });
      } else {
        await seedInstalledPluginIndex({}, { env, config });
      }
    },
    async publish(run: NonNullable<UpdateCommandOptions["run"]>) {
      const { runId } = run;
      const beforeIndependent = loadPluginCohortRecovery(runId, { env });
      if (mode === "migration") {
        const fence = run.executorFence;
        assert(fence && beforeIndependent, "The witness requires the actual admitted native run");
        const before = readMigration();
        await withPluginCohortConfigCapture(
          {
            runId,
            installKey: beforeIndependent.cohort.installKey,
            env,
            assertCurrent: () => fence.assertCurrent(),
          },
          () =>
            recordDeferredPluginMigrations({
              env,
              pending: [{ ...obligation, reason: "owned decision B" }],
            }),
        );
        const owned = loadPluginCohortRecovery(runId, { env });
        expect(owned?.cohort.publications).toContainEqual({
          kind: "plugin-migrations",
          rows: [
            {
              pluginId: "independent",
              before: {
                startedAt: before!.started_at,
                finishedAt: before!.finished_at,
                status: before!.status,
                reportJson: before!.report_json,
              },
              after: expect.objectContaining({
                reportJson: expect.stringContaining("owned decision B"),
              }),
            },
          ],
        });
        await pluginCohortPublicationContext.exit(() =>
          recordDeferredPluginMigrations({
            env,
            pending: [{ ...obligation, reason: "independent decision C" }],
          }),
        );
        independentMigration = readMigration();
        expect(JSON.parse(String(independentMigration?.report_json)).reason).toBe(
          "independent decision C",
        );
        expect(loadPluginCohortRecovery(runId, { env })).toEqual(owned);
        return;
      }
      await fs.mkdir(independentPath, { recursive: true });
      await writeJson(path.join(independentPath, "package.json"), {
        name: "@example/independent",
        version: "1.0.0",
        openclaw: { extensions: ["./index.js"] },
      });
      await writeJson(path.join(independentPath, "openclaw.plugin.json"), {
        id: "independent",
        configSchema: { type: "object" },
      });
      await fs.writeFile(path.join(independentPath, "index.js"), "export default {};\n");
      await pluginCohortPublicationContext.exit(() =>
        seedInstalledPluginIndex({ independent: independentRecord }, { env, config }),
      );
      expect(independentRecords().independent).toEqual(independentRecord);
      expect(loadPluginCohortRecovery(runId, { env })).toEqual(beforeIndependent);
    },
    observeSettlement(operation: Promise<unknown>) {
      return mode === "migration"
        ? operation.finally(() => expect(readMigration()).toEqual(independentMigration))
        : operation;
    },
    async expectPendingRecovery(operation: Promise<unknown>) {
      await expect(operation).rejects.toMatchObject({
        exitCode: 1,
        result: { status: "error", recovery: { serviceRestartSafe: false } },
        cause: {
          name: "UpdateCommandRecoveryPendingError",
          cause: {
            message: expect.stringContaining(
              mode === "migration"
                ? "Plugin migration independent changed outside the update"
                : "Plugin independent changed outside the update",
            ),
          },
        },
      });
    },
    async expectPreserved({
      doctorEvidence,
      migratedVersions,
      runId,
      transactionId,
      readState,
      packageRoot,
      starts,
      readService,
    }: {
      doctorEvidence: string;
      migratedVersions: readonly number[];
      runId: string;
      transactionId: string | undefined;
      readState: () => unknown;
      packageRoot: string;
      starts: readonly string[];
      readService: () => ChildProcess | undefined;
    }) {
      expect(
        JSON.parse(await fs.readFile(doctorEvidence, "utf8")).map(
          (entry: { version: number }) => entry.version,
        ),
      ).toEqual(migratedVersions);
      expect(
        loadPluginCohortRecovery(runId, { env, allowNativeRead: true })?.cohort.transactionId,
      ).toBe(transactionId);
      expect(readState()).toEqual({
        shared: {
          version: migratedVersions[0],
          rows: candidateRows,
          columns: ["value", "migrated"],
        },
        agent: {
          version: migratedVersions[1],
          rows: candidateRows,
          columns: ["value", "migrated"],
        },
      });
      expect(await readVersion(packageRoot)).toBe("2.0.0");
      expect(starts).toEqual(["1.0.0"]);
      expect(readService()).toBeUndefined();
      if (mode === "migration") {
        expect(readMigration()).toEqual(independentMigration);
      } else {
        expect(independentRecords().independent).toEqual(independentRecord);
        expect(await fs.readFile(path.join(independentPath, "index.js"), "utf8")).toBe(
          "export default {};\n",
        );
      }
    },
  };
}
