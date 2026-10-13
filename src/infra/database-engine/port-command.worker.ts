import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import type { WorkboardDatabasePortApi } from "@openclaw/workboard-contract";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import { readBackupEngine } from "../../snapshot/database-backup.js";
import { hasErrnoCode } from "../errno.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { prepareSqliteReadOnlyLocationSync } from "../sqlite-snapshot-source.js";
import { createSqliteWalCheckpoint } from "../sqlite-wal-checkpoint.js";
import { WorkerTaskError } from "../worker-task-pool.js";
import { resolveDatabaseEngineInput, type DatabaseEngineInput } from "./config.js";
import {
  DatabasePortDataError,
  inspectDatabasePort,
  inspectSqlitePortSchema,
  materializeDatabasePort,
  readPostgresPortCapabilities,
  type PortDescriptor,
  type PortVerification,
} from "./port.worker.js";
import { loadWorkboardPortDescriptor, withWorkboardPostgres } from "./workboard-port.js";

type Common = { sourcePath: string; config: OpenClawConfig };
type Identity = { storeId: string; namespace: string };
export type WorkboardPortTask =
  | ({ operation: "inspect"; to: "sqlite" | "postgres" } & Common)
  | { operation: "preflight"; config: OpenClawConfig; probe: boolean; namespace?: string }
  | { operation: "migrate"; sourcePath: string }
  | ({
      operation: "stage";
      targetPath: string;
      to: "sqlite" | "postgres";
      sourceVerification?: PortVerification;
      resume?: boolean;
    } & Common &
      Identity)
  | ({
      operation: "verify";
      engine: "sqlite" | "postgres";
      verification: PortVerification;
    } & Common &
      Identity)
  | { operation: "checkpoint"; sourcePath: string };
export type WorkboardPortInspection = Partial<Identity> & {
  engine: "sqlite" | "postgres";
  version: number;
  descriptorHash: string;
  targetVersion: number;
  migrationRequired: boolean;
  verification?: PortVerification;
};
type ReplyMap = {
  inspect: WorkboardPortInspection;
  preflight: Awaited<ReturnType<typeof preflight>>;
  migrate: { descriptorHash: string; verification: PortVerification };
  stage: ReplyMap["migrate"];
  verify: void;
  checkpoint: void;
};
type Reply = ReplyMap[keyof ReplyMap];
type Scope = { assertCurrent: () => void; signal?: AbortSignal };
export class WorkboardPortError extends Error {}
function workboardApi() {
  return loadBundledPluginPublicArtifactModuleSync<{
    workboardDatabasePortApi: WorkboardDatabasePortApi<DatabaseSync, DatabaseEngineInput>;
  }>({ dirName: "workboard", artifactBasename: "database-port-api.js" }).workboardDatabasePortApi;
}
function refuse(fact: string): never {
  throw new DatabasePortDataError(fact);
}
function compare(actual: PortVerification, expected: PortVerification) {
  if (!isDeepStrictEqual(actual, expected)) {
    refuse("observed changed canonical rows or allocations; required recorded verification");
  }
}
async function inspectSqlite(
  sourcePath: string,
  descriptor: PortDescriptor,
  allowMigration = false,
) {
  const prepared = prepareSqliteReadOnlyLocationSync(sourcePath);
  try {
    using db = openNodeSqliteDatabase(prepared.location, { readOnly: true, readBigInts: true });
    const { version, migrationRequired, pendingColumns } =
      workboardApi().inspectWorkboardPortSource(db);
    if (allowMigration && migrationRequired) {
      inspectSqlitePortSchema(db, descriptor, pendingColumns);
      return { version, migrationRequired };
    }
    const { tables, allocations } = await inspectDatabasePort({ engine: "sqlite", db }, descriptor);
    return { version, migrationRequired, verification: { tables, allocations } };
  } finally {
    prepared.cleanup();
  }
}
async function inspectPostgres(
  db: import("pg").Client,
  descriptor: PortDescriptor,
  identity: Identity,
  verifyDefinitions = true,
) {
  const owner = (
    await db.query(
      "SELECT nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_namespace WHERE nspname = $1",
      [identity.namespace],
    )
  ).rows[0];
  if (!owner?.owned) {
    refuse(
      "observed missing namespace or different owner; required namespace owned by the configured role",
    );
  }
  await db.query("SET row_security = off");
  const { tables, allocations } = await inspectDatabasePort(
    { engine: "postgres", db, namespace: identity.namespace },
    descriptor,
    identity.storeId,
    verifyDefinitions,
  );
  return { tables, allocations };
}
async function preflight(
  task: Extract<WorkboardPortTask, { operation: "preflight" }>,
  assertCurrent: () => void,
) {
  return withWorkboardPostgres(task.config, async (db, descriptor) => {
    const facts = await readPostgresPortCapabilities(db, descriptor);
    if (task.probe) {
      const namespace = task.namespace ?? `port_probe_${randomUUID().replaceAll("-", "")}`;
      await db.query("BEGIN");
      try {
        assertCurrent();
        await db.query(
          `CREATE SCHEMA "${namespace}"; CREATE TABLE "${namespace}".probe (n INTEGER); INSERT INTO "${namespace}".probe VALUES (1); SELECT n FROM "${namespace}".probe; DROP TABLE "${namespace}".probe; DROP SCHEMA "${namespace}"`,
        );
      } catch {
        refuse(
          "observed failed namespace privilege probe; required CREATE, INSERT, SELECT and DROP privileges",
        );
      } finally {
        await db.query("ROLLBACK");
      }
    }
    return { ...facts, privilegesChecked: task.probe };
  });
}
async function stage(
  task: Extract<WorkboardPortTask, { operation: "stage" }>,
  descriptor: PortDescriptor,
  assertCurrent: () => void,
): Promise<PortVerification> {
  const { migrationRequired, verification } = await inspectSqlite(task.sourcePath, descriptor);
  if (migrationRequired || !verification) {
    refuse("observed unmigrated private source; required migrate phase before staging");
  }
  if (task.sourceVerification) {
    compare(verification, task.sourceVerification);
  }
  const occupied = await fs.stat(task.targetPath).then(
    () => true,
    (error: unknown) =>
      hasErrnoCode(error, "ENOENT")
        ? false
        : Promise.reject(new Error("Unable to inspect staging target", { cause: error })),
  );
  if (occupied) {
    if (!task.resume) {
      refuse("observed occupied target file; required absent private staging path");
    }
    const { targetPath: sourcePath, to: engine } = task;
    try {
      await verify({ ...task, operation: "verify", sourcePath, engine, verification }, descriptor);
      return verification;
    } catch {
      // Only unverified private staging is rebuilt; occupied namespaces are checked below.
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        assertCurrent();
        await fs.rm(task.targetPath + suffix, { force: true });
      }
    }
  }
  if (task.to === "postgres") {
    try {
      await withWorkboardPostgres(task.config, async (db) => {
        const exists = (
          await db.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [task.namespace])
        ).rowCount;
        if (exists) {
          if (!task.resume) {
            refuse("observed occupied target namespace; required fresh namespace");
          }
          compare(await inspectPostgres(db, descriptor, task), verification);
          return;
        }
        await preflight(
          { operation: "preflight", config: task.config, probe: true, namespace: task.namespace },
          assertCurrent,
        );
        using image = openNodeSqliteDatabase(task.sourcePath, {
          readOnly: true,
          readBigInts: true,
        });
        compare(
          await materializeDatabasePort({
            source: { engine: "sqlite", db: image },
            destination: { engine: "postgres", db, namespace: task.namespace },
            descriptor,
            storeId: task.storeId,
            assertCurrent,
          }),
          verification,
        );
      });
    } catch (error) {
      if (error instanceof DatabasePortDataError) {
        throw error;
      }
      // COMMIT may have succeeded despite a lost reply; the fresh connection below decides.
    }
    await withWorkboardPostgres(task.config, async (db) =>
      compare(await inspectPostgres(db, descriptor, task), verification),
    );
    assertCurrent();
    await fs.writeFile(task.targetPath, "", { flag: "wx", mode: 0o600 });
    using anchor = openNodeSqliteDatabase(task.targetPath);
    anchor.exec(
      "CREATE TABLE openclaw_engine_anchor (store_id TEXT NOT NULL, engine TEXT NOT NULL CHECK (engine = 'postgres'), schema TEXT NOT NULL)",
    );
    anchor
      .prepare("INSERT INTO openclaw_engine_anchor VALUES (?, 'postgres', ?)")
      .run(task.storeId, task.namespace);
  } else {
    const { createVerifiedSqliteSnapshot } = await import("../sqlite-snapshot.js");
    await createVerifiedSqliteSnapshot({
      sourcePath: task.sourcePath,
      targetPath: task.targetPath,
      preserveRowIds: true,
    });
  }
  assertCurrent();
  workboardApi().admitWorkboardPort(
    task.targetPath,
    task.to === "postgres" ? await resolveDatabaseEngineInput(task.config) : undefined,
  );
  if (task.to === "sqlite") {
    compare((await inspectSqlite(task.targetPath, descriptor)).verification!, verification);
  }
  return verification;
}
async function verify(
  task: Extract<WorkboardPortTask, { operation: "verify" }>,
  descriptor: PortDescriptor,
) {
  const engine = readBackupEngine(task.sourcePath);
  if (
    engine.engine !== task.engine ||
    (engine.engine === "postgres" &&
      (engine.storeId !== task.storeId || engine.namespace !== task.namespace))
  ) {
    refuse(
      "observed mismatched anchor identity; required recorded engine, store UUID and namespace",
    );
  }
  const actual =
    task.engine === "postgres"
      ? await withWorkboardPostgres(task.config, (db) => inspectPostgres(db, descriptor, task))
      : (await inspectSqlite(task.sourcePath, descriptor)).verification!;
  compare(actual, task.verification);
}
async function execute(task: WorkboardPortTask, assertCurrent: () => void): Promise<Reply> {
  if (task.operation === "preflight") {
    return preflight(task, assertCurrent);
  }
  if (task.operation === "checkpoint") {
    using db = openNodeSqliteDatabase(task.sourcePath);
    assertCurrent();
    if (
      !createSqliteWalCheckpoint(db, { databasePath: task.sourcePath }, 0).checkpoint("TRUNCATE")
    ) {
      refuse("observed busy SQLite WAL; required all readers and writers stopped");
    }
    return;
  }
  const descriptor = await loadWorkboardPortDescriptor();
  const descriptorHash = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  if (task.operation === "inspect") {
    const engine = readBackupEngine(task.sourcePath);
    const facts =
      engine.engine === "postgres"
        ? await withWorkboardPostgres(task.config, async (db) => ({
            version: descriptor.version,
            migrationRequired: false,
            verification: await inspectPostgres(db, descriptor, engine, false),
          }))
        : await inspectSqlite(task.sourcePath, descriptor, true);
    return { ...engine, ...facts, descriptorHash, targetVersion: descriptor.version };
  }
  if (task.operation === "migrate") {
    await inspectSqlite(task.sourcePath, descriptor, true);
    assertCurrent();
    workboardApi().admitWorkboardPort(task.sourcePath);
  }
  if (task.operation === "migrate" || task.operation === "stage") {
    const verification =
      task.operation === "stage"
        ? await stage(task, descriptor, assertCurrent)
        : (await inspectSqlite(task.sourcePath, descriptor)).verification!;
    return { descriptorHash, verification };
  }
  return verify(task, descriptor);
}

export function runWorkboardPortTask<T extends WorkboardPortTask>(
  task: T,
  scope: Scope,
): Promise<ReplyMap[T["operation"]]>;
/** Joins the one-shot native worker before the caller may publish any active pathname. */
export async function runWorkboardPortTask(task: WorkboardPortTask, scope: Scope): Promise<Reply> {
  scope.assertCurrent();
  const { WorkerTaskPool } = await import("../worker-task-pool.js");
  const pool = new WorkerTaskPool<WorkboardPortTask, Reply>({
    workerUrl: new URL(import.meta.url),
    maxWorkers: 1,
    workerOptions: { workerData: { openclawPortCommand: true } },
  });
  try {
    const result = await pool.run(task, { signal: scope.signal });
    scope.assertCurrent();
    return result;
  } catch (error) {
    if (
      error instanceof WorkerTaskError &&
      error.code === "failed" &&
      error.message.startsWith(`${task.operation}: `)
    ) {
      throw new WorkboardPortError(error.message);
    }
    throw error;
  } finally {
    await pool.close();
  }
}
if (parentPort && workerData?.openclawPortCommand === true) {
  const { serveWorkerTasks } = await import("../worker-task-server.js");
  serveWorkerTasks((value, _channel, control) =>
    control.runNativeSection(async () => {
      // SAFETY: The private one-shot host exclusively supplies this structured-clone task.
      const task = value as WorkboardPortTask;
      try {
        return await execute(task, control.throwIfCancelled);
      } catch (error) {
        const fact =
          error instanceof DatabasePortDataError ||
          error instanceof workboardApi().WorkboardPortSchemaError
            ? error.message
            : "observed database validation or I/O failure; required readable, valid data and namespace privileges";
        throw new Error(
          `${task.operation}: ${"sourcePath" in task ? task.sourcePath : "workboard"}: ${fact}. Stop the Gateway, correct the source or connection, then retry or use the retained recovery manifest.`,
          { cause: error },
        );
      }
    }),
  );
}
