import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasErrnoCode } from "../errno.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { getPostgresPool } from "../postgres-sync/pool.js";
import { runtimeProcessEntrypoints } from "../runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../runtime-worker-url.js";
import { prepareSqliteReadOnlyLocationSync } from "../sqlite-snapshot-source.js";
import { createSqliteWalCheckpoint } from "../sqlite-wal-checkpoint.js";
import { WorkerTaskError } from "../worker-task-pool.js";
import { resolveDatabaseEngineInput } from "./config.js";
import { getScopedDatabaseEngineSelection } from "./context.js";
import { readBackupEngine, readBackupEngineImage, type BackupEngine } from "./physical-store.js";
import {
  assertDatabasePortNamespaceOwner,
  databasePortProviders,
  sqliteDatabasePortProvider,
  withDatabasePortConnection,
  withDatabasePortPostgres,
} from "./port-provider.js";
import {
  DatabasePortDataError,
  inspectDatabasePort,
  inspectSqlitePortSchema,
  materializeDatabasePort,
  migrateDatabasePortSource,
  readPostgresPortCapabilities,
  sqlitePortAllocations,
  type PortDescriptor,
  type PortVerification,
} from "./port.worker.js";
import {
  refreshPostgresPlannerStatistics,
  type PostgresPlannerStatistics,
} from "./postgres-planner-statistics.js";

type Common = { sourcePath: string; config: OpenClawConfig };
type Identity = { storeId: string; namespace: string };
export type DatabasePortTask =
  | ({ operation: "analyze" } & Common)
  | ({ operation: "inspect"; to: "sqlite" | "postgres" } & Common)
  | { operation: "preflight"; config: OpenClawConfig; probe: boolean; namespace?: string }
  // Migration and staging consume an exclusively owned private SQLite image.
  | { operation: "migrate"; sourcePath: string; config?: OpenClawConfig }
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
export type DatabasePortInspection = Partial<Identity> & {
  family: string;
  engine: "sqlite" | "postgres";
  version: number;
  descriptorHash: string;
  targetVersion: number;
  migrationRequired: boolean;
  notes?: readonly string[];
  verification?: PortVerification;
};
type ReplyMap = {
  inspect: DatabasePortInspection;
  preflight: Awaited<ReturnType<typeof preflight>>;
  migrate: { descriptorHash: string; verification: PortVerification };
  stage: ReplyMap["migrate"] & { plannerStatistics?: PostgresPlannerStatistics };
  analyze: PostgresPlannerStatistics | undefined;
  verify: void;
  checkpoint: void;
};
export type DatabasePortReply = ReplyMap[keyof ReplyMap];
type Scope = { assertCurrent: () => void; signal?: AbortSignal };
export class DatabasePortError extends Error {}
function refuse(fact: string): never {
  throw new DatabasePortDataError(fact);
}
function compare(actual: PortVerification, expected: PortVerification) {
  if (!isDeepStrictEqual(actual, expected)) {
    refuse("observed changed canonical rows or allocations; required recorded verification");
  }
}
async function inspectSqliteImage(
  db: DatabaseSync,
  descriptor: PortDescriptor,
  allowMigration = false,
) {
  const {
    version,
    migrationRequired: schemaMigrationRequired,
    pendingColumns,
  } = descriptor.inspectSqliteSource?.(db) ?? {
    version: (await import("../sqlite-user-version.js")).readSqliteUserVersion(db),
    migrationRequired: false,
    pendingColumns: {},
  };
  // Port preparation also fills first-use columns that the live store may omit.
  const migrationRequired =
    schemaMigrationRequired || Object.values(pendingColumns).some((columns) => columns.length > 0);
  if (allowMigration && migrationRequired) {
    // Historical repairs use family admission; current first-use repairs still
    // need the port's complete layout before preparing a private copy.
    const admitted =
      !schemaMigrationRequired || !descriptor.migrateSqliteSource
        ? inspectSqlitePortSchema(db, descriptor, pendingColumns)
        : descriptor;
    return { version, migrationRequired, notes: admitted.notes };
  }
  const admitted = inspectSqlitePortSchema(db, descriptor);
  const { tables, allocations } = await inspectDatabasePort({ engine: "sqlite", db }, admitted);
  return {
    version,
    migrationRequired,
    notes: admitted.notes,
    verification: { tables, allocations },
  };
}
async function inspectSqlite(sourcePath: string, descriptor: PortDescriptor) {
  const prepared = prepareSqliteReadOnlyLocationSync(sourcePath);
  try {
    using db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
    return await inspectSqliteImage(db, descriptor);
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
  await assertDatabasePortNamespaceOwner(db, identity.namespace);
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
  task: Extract<DatabasePortTask, { operation: "preflight" }>,
  assertCurrent: () => void,
) {
  return withDatabasePortConnection(task.config, async (db) => {
    await readPostgresPortCapabilities(db, {
      minimumPostgresVersion: Math.max(
        ...databasePortProviders.map((provider) => provider.minimumPostgresVersion),
      ),
    });
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
  });
}
async function stage(
  task: Extract<DatabasePortTask, { operation: "stage" }>,
  descriptor: PortDescriptor,
  assertCurrent: () => void,
  source: Awaited<ReturnType<typeof inspectSqliteImage>>,
): Promise<{ verification: PortVerification; plannerStatistics?: PostgresPlannerStatistics }> {
  const { migrationRequired, verification } = source;
  let plannerStatistics: PostgresPlannerStatistics | undefined;
  if (migrationRequired || !verification) {
    refuse("observed unmigrated private source; required migrate phase before staging");
  }
  if (task.sourceVerification) {
    compare(
      verification,
      task.to === "sqlite"
        ? {
            ...task.sourceVerification,
            allocations: sqlitePortAllocations(
              descriptor,
              verification.allocations,
              task.sourceVerification.allocations,
            ),
          }
        : task.sourceVerification,
    );
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
      return { verification };
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
      await withDatabasePortConnection(task.config, async (db) => {
        const exists = (
          await db.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [task.namespace])
        ).rowCount;
        if (exists) {
          if (!task.resume) {
            refuse("observed occupied target namespace; required fresh namespace");
          }
          compare(await inspectPostgres(db, descriptor, task), verification);
          plannerStatistics = await refreshPostgresPlannerStatistics(db, task.namespace);
          return;
        }
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
            onPlannerStatistics: (result) => {
              plannerStatistics = result;
            },
          }),
          verification,
        );
      });
    } catch (error) {
      if (error instanceof DatabasePortDataError) {
        throw error;
      }
      // COMMIT may have succeeded despite a lost reply; the fresh connection below decides.
      await withDatabasePortConnection(task.config, async (db) =>
        compare(await inspectPostgres(db, descriptor, task), verification),
      );
    }
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
      sourceAcquisition: {
        mode: "isolated-process",
        stagingRoot: path.dirname(task.targetPath),
        preserveSourceArtifacts: true,
      },
    });
  }
  assertCurrent();
  await descriptor.admit?.(
    task.targetPath,
    task.to === "postgres"
      ? (getScopedDatabaseEngineSelection()?.postgres ??
          (await resolveDatabaseEngineInput(task.config)))
      : undefined,
  );
  if (task.to === "sqlite") {
    using image = openNodeSqliteDatabase(task.targetPath, { readOnly: true });
    compare((await inspectSqliteImage(image, descriptor)).verification!, verification);
  }
  return { verification, plannerStatistics };
}
async function verify(
  task: Extract<DatabasePortTask, { operation: "verify" }>,
  descriptor: PortDescriptor,
  source?: { engine: BackupEngine; facts?: Awaited<ReturnType<typeof inspectSqliteImage>> },
) {
  const engine = source?.engine ?? readBackupEngine(task.sourcePath);
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
      ? await withDatabasePortConnection(task.config, (db) => inspectPostgres(db, descriptor, task))
      : (source?.facts ?? (await inspectSqlite(task.sourcePath, descriptor))).verification!;
  compare(actual, task.verification);
}
export async function executeDatabasePortTask(
  task: DatabasePortTask,
  assertCurrent: () => void,
): Promise<DatabasePortReply> {
  if (task.operation === "analyze") {
    const anchor = readBackupEngine(task.sourcePath);
    if (anchor.engine === "postgres") {
      return withDatabasePortConnection(
        task.config,
        async (db) => {
          await assertDatabasePortNamespaceOwner(db, anchor.namespace);
          assertCurrent();
          return refreshPostgresPlannerStatistics(db, anchor.namespace);
        },
        process.env,
        { connectionTimeoutMillis: 5_000, query_timeout: 15_000 },
      );
    }
    return;
  }
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
  const { loadDatabasePortDescriptor } = await import("./port-provider-descriptor.js");
  const source = await (async () => {
    // Published sources still need process isolation; private phase inputs already have it.
    const prepared =
      task.operation === "migrate" || task.operation === "stage"
        ? undefined
        : prepareSqliteReadOnlyLocationSync(task.sourcePath);
    const imagePath = prepared?.location ?? task.sourcePath;
    try {
      const engine = readBackupEngineImage(imagePath, task.sourcePath);
      if (engine.engine === "postgres") {
        if (task.operation === "migrate" || task.operation === "stage") {
          refuse("private migration and staging require a SQLite image");
        }
        const descriptor = await withDatabasePortPostgres(
          task.config,
          engine,
          async (_db, family) => family,
        );
        return { engine, descriptor, facts: undefined };
      }
      using db = openNodeSqliteDatabase(imagePath, { readOnly: true });
      const descriptor = await loadDatabasePortDescriptor(
        sqliteDatabasePortProvider(db).id,
        "config" in task ? task.config : undefined,
      );
      const facts = await inspectSqliteImage(
        db,
        descriptor,
        task.operation === "inspect" || task.operation === "migrate",
      );
      return { engine, descriptor, facts };
    } finally {
      prepared?.cleanup();
    }
  })();
  const { engine, descriptor } = source;
  const descriptorHash = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
  if (task.operation === "inspect") {
    const facts =
      engine.engine === "postgres"
        ? await withDatabasePortConnection(task.config, async (db) => ({
            version: descriptor.version,
            migrationRequired: false,
            verification: await inspectPostgres(db, descriptor, engine, false),
          }))
        : source.facts!;
    return {
      ...engine,
      ...facts,
      family: descriptor.id,
      descriptorHash,
      targetVersion: descriptor.version,
    };
  }
  if (task.operation === "migrate" || task.operation === "stage") {
    const result =
      task.operation === "stage"
        ? await stage(task, descriptor, assertCurrent, source.facts!)
        : {
            verification: await migrateDatabasePortSource(
              task.sourcePath,
              descriptor,
              source.facts!.version,
              assertCurrent,
            ),
          };
    return { descriptorHash, ...result };
  }
  return verify(task, descriptor, source);
}

export function runDatabasePortTask<T extends DatabasePortTask>(
  task: T,
  scope: Scope,
): Promise<ReplyMap[T["operation"]]>;
/** Joins the one-shot native worker before the caller may publish any active pathname. */
export async function runDatabasePortTask(
  task: DatabasePortTask,
  scope: Scope,
): Promise<DatabasePortReply> {
  scope.assertCurrent();
  // Target schema admission needs PostgreSQL while the caller still selects SQLite.
  if (task.operation === "stage" && task.to === "postgres") {
    getPostgresPool();
  }
  const { WorkerTaskPool } = await import("../worker-task-pool.js");
  const pool = new WorkerTaskPool<DatabasePortTask, DatabasePortReply>({
    workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.databasePortCommand),
    maxWorkers: 1,
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
      throw new DatabasePortError(error.message);
    }
    throw error;
  } finally {
    await pool.close();
  }
}
