import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db-contract.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import {
  closeTrackedStateDatabase,
  openTrackedStateDatabase,
} from "../state/openclaw-state-db-handle.js";
import { assertStateReadSchema } from "../state/openclaw-state-db-read-connection.js";
import {
  executeExistingOpenClawStateRead,
  withArtifactPreservingStateReads,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runManagedStateTransaction } from "../state/openclaw-state-db-transaction.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getOpenClawStateFeatureSchemaSql } from "../state/openclaw-state-feature-schema.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";
import {
  capturePluginCohortMigrationRowsBeforeWrite,
  captureCohortMigrationContext,
  cohortMigrationBinding,
  recordPluginCohortMigrationRowsAfterWrite,
  restorePluginCohortMigrationRowsInDatabase,
} from "./deferred-plugin-migrations.cohort.js";
import {
  DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX as RUN_PREFIX,
  deferredPluginMigrationSchema,
  type DeferredPluginMigration,
} from "./deferred-plugin-migrations.contract.js";
import { isTruthyEnvValue } from "./env.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "./kysely-sync-cache-state.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { setSqliteBusyTimeout } from "./sqlite-busy-timeout.js";
import {
  getOrLoadSqliteDatabaseAdmissionForPath,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "./sqlite-database-admission.js";
import { runWithSqliteCleanup, throwSqliteLifecycleErrors } from "./sqlite-lifecycle-errors.js";
import { invalidateSuccessfulMigrationCheckpointsInTransaction } from "./startup-migration-checkpoint.js";
import { withStateDatabaseSchemaMaintenance } from "./state-database-maintenance.js";
import { recordLegacyMigrationRun } from "./state-migrations.receipts.js";
import { foldPluginCohortMigrationPublications } from "./update-plugin-cohort-records.js";
import type {
  PluginCohortMigrationPublication,
  PluginCohortRecoveryWriteBinding,
} from "./update-plugin-cohort-schema.js";

export type { DeferredPluginMigration } from "./deferred-plugin-migrations.contract.js";

type PinnedMigrationRead = { invalidated: boolean; parent?: PinnedMigrationRead };
const pinnedMigrationRead = new AsyncLocalStorage<PinnedMigrationRead>();

function invalidatePinnedMigrationReads(): void {
  for (let read = pinnedMigrationRead.getStore(); read; read = read.parent) {
    read.invalidated = true;
  }
}

const migrationReceipt: SqliteDatabaseAdmissionKey<object> = {
  name: "plugins.deferred-migrations",
  lifetime: "process",
  read: (value) => (isRecord(value) ? value : undefined),
};

/** Only committed migration writes retire readiness; ordinary state writes do not. */
export function readDeferredPluginMigrationReceipt(databasePath: string): object {
  return getOrLoadSqliteDatabaseAdmissionForPath(databasePath, migrationReceipt, () => ({})) ?? {};
}

type ConfigMigrationCompletion = {
  configPath: string;
  expectedPending: readonly DeferredPluginMigration[];
  resolvedPluginIds: readonly string[];
  assertCurrent: () => void;
  published: boolean;
};
const configMigrationCompletion = new AsyncLocalStorage<ConfigMigrationCompletion>();

/** The package owner may finish inspected config-only work through the normal file publisher. */
export async function withDeferredPluginConfigCompletion<T>(
  params: Omit<ConfigMigrationCompletion, "published">,
  run: () => Promise<T>,
): Promise<T> {
  return await configMigrationCompletion.run({ ...params, published: false }, run);
}

/** The file rollback's live owner also restores its completed migration obligations. */
export function withDeferredPluginConfigRollback(
  params: { configPath: string; env?: NodeJS.ProcessEnv; assertCurrent: () => void },
  publish: () => void,
  didMutate: () => boolean,
): void {
  const completion = configMigrationCompletion.getStore();
  if (!completion?.published || completion.configPath !== params.configPath) {
    publish();
    return;
  }
  let failure: { error: unknown } | undefined;
  const pluginCohort = cohortMigrationBinding(captureCohortMigrationContext(params.env));
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      params.assertCurrent();
      recordDeferredPluginMigrationsInTransaction(
        db,
        {
          pending: completion.expectedPending,
          expectedPending: completion.expectedPending.filter(
            (entry) => !completion.resolvedPluginIds.includes(entry.pluginId),
          ),
        },
        pluginCohort,
      );
      try {
        publish();
      } catch (error) {
        if (!didMutate()) {
          throw error;
        }
        failure = { error };
      }
      if (!didMutate()) {
        throw new Error("Config rollback did not publish its restoration.");
      }
      // Each mutation checked its live owner. No await remains; settle the observed file effect
      // even when post-publication verification has since refused that file guard.
    },
    { env: params.env },
    { operationLabel: "state.plugin-migration-input-rollback" },
  );
  completion.published = false;
  // A post-rename verification error must not undo already-restored obligations.
  if (failure) {
    throw failure.error;
  }
}

/** Ordinary writes consume canonical config; only migration owners supply pending facts. */
export async function readConfigWritePendingMigrations(
  configPath: string,
  env?: NodeJS.ProcessEnv,
  preparedPending?: readonly DeferredPluginMigration[],
): Promise<readonly DeferredPluginMigration[] | undefined> {
  const completion = configMigrationCompletion.getStore();
  if (!completion || completion.configPath !== configPath) {
    return preparedPending;
  }
  completion.assertCurrent();
  if (completion.published) {
    return await readDeferredPluginMigrationsAsync({ env });
  }
  // Publication asserts this generation inside its write transaction; reading it here only repeats that.
  return completion.expectedPending.filter(
    (entry) => !completion.resolvedPluginIds.includes(entry.pluginId),
  );
}

export class DeferredPluginMigrationConflictError extends Error {
  readonly pending: readonly DeferredPluginMigration[];

  constructor(
    pending: readonly DeferredPluginMigration[],
    context: {
      expected?: readonly DeferredPluginMigration[];
      phase?: string;
    } = {},
  ) {
    const phase = context.phase ?? "migration settlement";
    const difference = context.expected
      ? ` expected=${formatConflictIds(context.expected.map((entry) => entry.pluginId))}, current=${formatConflictIds(pending.map((entry) => entry.pluginId))}, changed=${formatChangedObligationFields(context.expected, pending)}.`
      : "";
    super(
      `Plugin migration obligations changed during ${phase}.${difference} Retained inputs remain protected; run "openclaw doctor --fix" after the other repair finishes.`,
    );
    this.name = "DeferredPluginMigrationConflictError";
    this.pending = pending;
  }
}

const MAX_CONFLICT_DIAGNOSTIC_ITEMS = 4;

function formatConflictIds(ids: readonly string[]): string {
  const sorted = [...new Set(ids)].toSorted();
  const visible = sorted.slice(0, MAX_CONFLICT_DIAGNOSTIC_ITEMS);
  const omitted = sorted.length - visible.length;
  return `[${visible.join(", ")}${omitted > 0 ? `, +${omitted} more` : ""}]`;
}

function formatChangedObligationFields(
  expected: readonly DeferredPluginMigration[],
  current: readonly DeferredPluginMigration[],
): string {
  const currentById = new Map(current.map((entry) => [entry.pluginId, entry]));
  const fields = deferredPluginMigrationSchema.keyof().options;
  const changed: string[] = [];
  for (const before of expected) {
    const after = currentById.get(before.pluginId);
    if (!after) {
      continue;
    }
    for (const field of fields) {
      if (!isDeepStrictEqual(before[field], after[field])) {
        changed.push(`${before.pluginId}:${field}`);
      }
    }
  }
  return formatConflictIds(changed);
}

/** Missing metadata cannot release inputs already claimed by an unfinished migration. */
export function mergeDeferredPluginMigration(
  previous: DeferredPluginMigration | undefined,
  current: DeferredPluginMigration,
): DeferredPluginMigration {
  const mergePaths = (before: string[][] = [], after: string[][] = []) => [
    ...new Map(
      [...before, ...after].map((segments) => [JSON.stringify(segments), segments]),
    ).values(),
  ];
  const configPaths = mergePaths(previous?.configPaths, current.configPaths);
  const validationExcludedPaths = mergePaths(
    previous?.validationExcludedPaths,
    current.validationExcludedPaths,
  );
  return {
    pluginId: current.pluginId,
    reason: current.reason,
    command: current.command,
    ...(previous?.requiresStateMigration || current.requiresStateMigration
      ? { requiresStateMigration: true as const }
      : {}),
    ...(previous?.requiresDoctorInspection || current.requiresDoctorInspection
      ? { requiresDoctorInspection: true as const }
      : {}),
    ...(configPaths.length > 0 ? { configPaths } : {}),
    ...(validationExcludedPaths.length > 0 ? { validationExcludedPaths } : {}),
  };
}

function readPendingMigrationRows(database: EngineConnection, includeDeferred = false) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "migration_runs">>(database)
      .selectFrom("migration_runs")
      .select(["id", "report_json", "status"])
      .where("id", "like", `${RUN_PREFIX}%`)
      .where("status", "in", includeDeferred ? ["pending", "deferred"] : ["pending"])
      .orderBy("id"),
  ).rows;
}

function pendingMigrationRecords(rows: ReturnType<typeof readPendingMigrationRows>) {
  return rows.map((row) => deferredPluginMigrationSchema.parse(JSON.parse(row.report_json)));
}

function readPendingMigrationRecords(database: EngineConnection, includeDeferred = false) {
  return tableExists(database, "migration_runs")
    ? pendingMigrationRecords(readPendingMigrationRows(database, includeDeferred))
    : [];
}

export const deferredPluginMigrationReadOperations = {
  "plugins.deferredMigrations.read": (input: { includeDeferred?: boolean } | undefined, db) => ({
    type: "plugins.deferredMigrations.read" as const,
    pending: readPendingMigrationRecords(db, input?.includeDeferred),
  }),
} satisfies WorkerOperationHandlers<EngineConnection>;

function assertPendingGeneration(
  current: readonly DeferredPluginMigration[],
  expected: readonly DeferredPluginMigration[],
  phase: string,
): void {
  if (!isDeepStrictEqual(current, expected)) {
    throw new DeferredPluginMigrationConflictError(current, { expected, phase });
  }
}

export function readDeferredPluginMigrations(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    artifactPreservingReadOnly?: boolean;
    /** Dormant obligations still gate runtime and must reach Doctor after activation. */
    includeDeferred?: boolean;
  } = {},
): readonly DeferredPluginMigration[] {
  const read =
    options.artifactPreservingReadOnly === false
      ? withExistingOpenClawStateDatabaseReadOnly
      : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
  return read(({ db }) => readPendingMigrationRecords(db, options.includeDeferred), options) ?? [];
}

/** Prime resolution in this module before the updater replaces its package. */
export async function prepareDeferredPluginMigrationRuntime(): Promise<void> {
  const { prepareOpenClawStateLeaseWorkerRuntime } =
    await import("../state/openclaw-state-lease-worker-operation.js");
  await Promise.all([
    import("../state/openclaw-state-worker-store.js"),
    import("../plugins/plugin-lifecycle-lease.js"),
    prepareOpenClawStateLeaseWorkerRuntime(),
  ]);
}

/** Keep Doctor and update inspection off the main thread without creating state. */
export async function readDeferredPluginMigrationsAsync(
  options: Parameters<typeof readDeferredPluginMigrations>[0] = {},
): Promise<readonly DeferredPluginMigration[]> {
  const read = () =>
    executeExistingOpenClawStateRead(options, {
      type: "plugins.deferredMigrations.read",
      input: options.includeDeferred ? { includeDeferred: true } : undefined,
    });
  const reply = await (options.artifactPreservingReadOnly === false
    ? read()
    : withArtifactPreservingStateReads(read));
  if (!reply) {
    return [];
  }
  return reply.pending;
}

/** The caller holds the plugin lifecycle lease until its last synchronous policy guard. */
export async function withLeasePinnedDeferredPluginMigrations<T>(
  options: {
    env: NodeJS.ProcessEnv;
    lease: {
      databasePath: string;
      assertOwned: () => void | Promise<void>;
      assertCurrent: () => void;
    };
  },
  run: (pending: readonly DeferredPluginMigration[], assertCurrent: () => void) => Promise<T>,
): Promise<T> {
  await options.lease.assertOwned();
  const pending = await readDeferredPluginMigrationsAsync({
    env: options.env,
    path: options.lease.databasePath,
  });
  await options.lease.assertOwned();
  const read: PinnedMigrationRead = {
    invalidated: false,
    ...(pinnedMigrationRead.getStore() ? { parent: pinnedMigrationRead.getStore() } : {}),
  };
  return await pinnedMigrationRead.run(read, async () =>
    run(pending, () => {
      options.lease.assertCurrent();
      if (read.invalidated) {
        throw new Error("Deferred plugin migration policy changed since review.");
      }
    }),
  );
}

/** Completion receipts resolve historical warnings without loading their retired reports. */
export function readDeferredPluginMigrationCompletions(
  options: Parameters<typeof readDeferredPluginMigrations>[0] = {},
) {
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
      if (!tableExists(db, "migration_runs")) {
        return [];
      }
      return executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "migration_runs">>(db)
          .selectFrom("migration_runs")
          .select(["id", "finished_at"])
          .where("id", "like", `${RUN_PREFIX}%`)
          .where("status", "in", ["completed", "superseded", "deferred"]),
      ).rows.flatMap(({ id, finished_at }) =>
        finished_at === null
          ? []
          : [{ pluginId: id.slice(RUN_PREFIX.length), completedAtMs: finished_at }],
      );
    }, options) ?? []
  );
}

/** Bind asynchronous settlement to the same pending records, including newly added owners. */
export function assertDeferredPluginMigrationsCurrent(params: {
  env?: NodeJS.ProcessEnv;
  expectedPending: readonly DeferredPluginMigration[];
}): void {
  withDeferredPluginMigrationsCurrent(params, () => undefined);
}

/** Keep competing obligation writers excluded until synchronous input publication finishes. */
export function withDeferredPluginMigrationsCurrent<T>(
  params: {
    env?: NodeJS.ProcessEnv;
    configPath?: string;
    expectedPending?: readonly DeferredPluginMigration[];
    phase?: string;
    onConflict?: (pending: readonly DeferredPluginMigration[]) => T;
  },
  publish: () => T,
): T {
  const scope = configMigrationCompletion.getStore();
  const completion =
    scope && scope.configPath === params.configPath && !scope.published ? scope : undefined;
  const expectedPending = completion?.expectedPending ?? params.expectedPending;
  if (expectedPending === undefined) {
    return publish();
  }
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  const pluginCohort = cohortMigrationBinding(captureCohortMigrationContext(params.env));
  const existing = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath);
  if (expectedPending.length === 0 && !existing) {
    if (!existsSync(databasePath)) {
      return withStateDatabaseSchemaMaintenance({ databasePath }, () =>
        existsSync(databasePath) ? withDeferredPluginMigrationsCurrent(params, publish) : publish(),
      );
    }
    // Historical empty state needs exclusion, but publication never owns its schema upgrade.
    const db = openTrackedStateDatabase(databasePath, { existingOnly: true });
    let publication: { value: T } | undefined;
    runWithSqliteCleanup(
      {
        release() {
          const errors: unknown[] = [];
          try {
            clearNodeSqliteKyselyCacheForDatabase(db);
          } catch (error) {
            errors.push(error);
          }
          try {
            closeTrackedStateDatabase(db);
          } catch (error) {
            errors.push(error);
          }
          throwSqliteLifecycleErrors(errors, "Plugin migration publication cleanup failed.");
        },
      },
      "Plugin migration input publication",
      () => {
        setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
        runManagedStateTransaction(
          db,
          (): T | undefined => {
            assertStateReadSchema(db, databasePath);
            if (readPendingMigrationRecords(db).length > 0) {
              return undefined;
            }
            const value = publish();
            publication = { value };
            return value;
          },
          {
            databaseLabel: databasePath,
            operationLabel: "state.plugin-migration-input-publication",
          },
        );
      },
    );
    if (publication) {
      return publication.value;
    }
  }
  const result = runOpenClawStateWriteTransaction(
    ({ db }) => {
      const pending = pendingMigrationRecords(readPendingMigrationRows(db));
      if (!isDeepStrictEqual(pending, expectedPending) && params.onConflict) {
        // Commit preservation facts against these rows; callers refuse publication after return.
        return params.onConflict(pending);
      }
      assertPendingGeneration(
        pending,
        expectedPending,
        params.phase ?? "migration input publication",
      );
      completion?.assertCurrent();
      const published = publish();
      if (completion) {
        completion.assertCurrent();
        recordDeferredPluginMigrationsInTransaction(
          db,
          {
            pending: pending.filter(
              (entry) => !completion.resolvedPluginIds.includes(entry.pluginId),
            ),
            resolvedPluginIds: completion.resolvedPluginIds,
            expectedPending,
          },
          pluginCohort,
        );
      }
      return published;
    },
    { env: params.env },
    { operationLabel: "state.plugin-migration-input-publication" },
  );
  if (completion) {
    completion.published = true;
  }
  return result;
}

export function formatDeferredPluginMigration(
  pending: DeferredPluginMigration,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const retry = pending.command === "openclaw doctor --fix" ? "" : ', then "openclaw doctor --fix"';
  // This formatter also ships in the minimal PR bootstrap, without Doctor command modules.
  const packageSwap =
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) &&
    !isTruthyEnvValue(env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE);
  const next = packageSwap
    ? `Let the current update or repair finish. If this warning remains afterward, run "${pending.command}"${retry} to retry the upgrade.`
    : `Run "${pending.command}"${retry} to retry the upgrade.`;
  return `Plugin "${pending.pluginId}" data/settings upgrade is unfinished: ${pending.reason} Your existing data and settings have been kept. ${next}`;
}

export type DeferredPluginMigrationRecordInput = {
  env?: NodeJS.ProcessEnv;
  pending: readonly DeferredPluginMigration[];
  resolvedPluginIds?: readonly string[];
  settlements?: readonly {
    pluginId: string;
    status: "completed" | "superseded" | "deferred";
    reason: string;
  }[];
  expectedPending?: readonly DeferredPluginMigration[];
};

/** Native row transform; the worker owns its transaction and lease grants. */
export function recordDeferredPluginMigrationsInTransaction(
  db: EngineConnection,
  params: Omit<DeferredPluginMigrationRecordInput, "env">,
  pluginCohort?: PluginCohortRecoveryWriteBinding,
) {
  const observation = capturePluginCohortMigrationRowsBeforeWrite(db, pluginCohort, params);
  if (params.pending.length > 0 || params.resolvedPluginIds?.length) {
    invalidatePinnedMigrationReads();
  }
  const pendingById = new Map(
    params.pending.map((pending) => [
      pending.pluginId,
      deferredPluginMigrationSchema.parse(pending),
    ]),
  );
  const currentRows = readPendingMigrationRows(db, true);
  if (params.expectedPending) {
    assertPendingGeneration(
      pendingMigrationRecords(currentRows.filter((row) => row.status === "pending")),
      params.expectedPending,
      "migration settlement",
    );
  }
  const rows = new Map(currentRows.map((row) => [row.id, row]));
  const deferred: DeferredPluginMigration[] = [];
  const resolved: string[] = [];
  const now = Date.now();
  for (const current of pendingById.values()) {
    const runId = `${RUN_PREFIX}${current.pluginId}`;
    const previous = rows.get(runId);
    const pending = mergeDeferredPluginMigration(
      previous ? deferredPluginMigrationSchema.parse(JSON.parse(previous.report_json)) : undefined,
      current,
    );
    const reportJson = JSON.stringify(pending);
    if (previous?.status === "pending" && previous.report_json === reportJson) {
      continue;
    }
    recordLegacyMigrationRun(db, {
      runId,
      startedAt: now,
      finishedAt: null,
      status: "pending",
      reportJson,
      upsert: true,
    });
    deferred.push(pending);
  }
  const settlements = new Map(params.settlements?.map((entry) => [entry.pluginId, entry]));
  for (const pluginId of new Set([...(params.resolvedPluginIds ?? []), ...settlements.keys()])) {
    const runId = `${RUN_PREFIX}${pluginId}`;
    const previous = rows.get(runId);
    if (pendingById.has(pluginId) || !previous) {
      continue;
    }
    const settlement = settlements.get(pluginId);
    recordLegacyMigrationRun(db, {
      runId,
      startedAt: now,
      finishedAt: now,
      status: settlement?.status ?? "completed",
      reportJson: settlement
        ? JSON.stringify({
            ...deferredPluginMigrationSchema.parse(JSON.parse(previous.report_json)),
            reason: settlement.reason,
          })
        : previous.report_json,
      upsert: true,
    });
    resolved.push(pluginId);
  }
  if (deferred.length > 0) {
    invalidateSuccessfulMigrationCheckpointsInTransaction(db);
  }
  if (deferred.length > 0 || resolved.length > 0) {
    publishSqliteDatabaseAdmission(db, migrationReceipt, {});
  }
  recordPluginCohortMigrationRowsAfterWrite(db, observation);
  return { deferred, resolved, pending: pendingMigrationRecords(readPendingMigrationRows(db)) };
}

/** Reopen only this updater's exact obligations; later Doctor decisions stay authoritative. */
export async function restorePluginCohortMigrationPublications(
  publications: readonly PluginCohortMigrationPublication[],
  authority: { env: NodeJS.ProcessEnv; assertCurrent: () => void },
): Promise<void> {
  authority.assertCurrent();
  if (publications.length === 0) {
    return;
  }
  const rows = foldPluginCohortMigrationPublications(publications);
  const present = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
    ({ db }) => tableExists(db, "migration_runs"),
    { env: authority.env },
  );
  authority.assertCurrent();
  if (!present) {
    if ([...rows.values()].some((row) => row.before !== undefined)) {
      throw new Error(
        "Plugin migration recovery is missing its original obligations; recovery preserved the database.",
      );
    }
    // A pre-migration backup can predate this obligation table. Original absence
    // is already restored; settlement must not initialize the candidate schema.
    return;
  }
  const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
  await withPluginLifecycleLease(
    { env: authority.env, schemaPolicy: "existing", assertCurrent: authority.assertCurrent },
    async (lease) => {
      const assertCurrent = () => {
        authority.assertCurrent();
        lease.assertOwned();
      };
      runExistingOpenClawStateWriteTransaction(
        ({ db }) => {
          restorePluginCohortMigrationRowsInDatabase(db, rows, assertCurrent, (database) => {
            invalidatePinnedMigrationReads();
            invalidateSuccessfulMigrationCheckpointsInTransaction(database);
            publishSqliteDatabaseAdmission(database, migrationReceipt, {});
          });
        },
        { env: authority.env },
        {
          operationLabel: "state.plugin-migration-cohort-rollback",
          schemaSql: ["schema_meta", "migration_runs"]
            .map((table) => getOpenClawStateFeatureSchemaSql(table))
            .join("\n"),
        },
      );
    },
  );
}

/** Only the migration owner can resolve a pending record after its work completes. */
export async function recordDeferredPluginMigrations(
  params: DeferredPluginMigrationRecordInput,
): Promise<readonly DeferredPluginMigration[] | undefined> {
  if (
    params.pending.length === 0 &&
    !params.resolvedPluginIds?.length &&
    !params.settlements?.length
  ) {
    return undefined;
  }
  invalidatePinnedMigrationReads();
  const input = structuredClone({
    pending: params.pending,
    resolvedPluginIds: params.resolvedPluginIds,
    settlements: params.settlements,
    expectedPending: params.expectedPending,
  });
  const { withPluginLifecycleLeaseAsync } = await import("../plugins/plugin-lifecycle-lease.js");
  const { runWithOpenClawStateLeaseWorker } =
    await import("../state/openclaw-state-lease-worker-operation.js");
  return withPluginLifecycleLeaseAsync({ env: params.env }, async (lease) => {
    const context = captureOpenClawStateWorkerContext({
      env: params.env,
      path: lease.databasePath,
    });
    const cohort = captureCohortMigrationContext(params.env);
    const pluginCohort = cohortMigrationBinding(cohort);
    const result = await runWithOpenClawStateLeaseWorker(
      lease.stateLease,
      context,
      (scope, identity) =>
        scope.execute({
          type: "plugins.deferredMigrations.record",
          input: {
            identity,
            ...input,
            ...(pluginCohort ? { pluginCohort } : {}),
          },
        }),
      {
        assertCurrent: () => {
          lease.assertCurrent();
          cohort?.assertCurrent();
        },
      },
    );
    if (result.kind === "conflict") {
      throw new DeferredPluginMigrationConflictError(result.pending, {
        expected: input.expectedPending,
      });
    }
    if (result.kind === "invalid") {
      throw new z.ZodError(result.issues);
    }
    const transitions = result.transitions;
    const log = createSubsystemLogger("state-migrations");
    for (const pending of transitions.deferred) {
      log.warn(formatDeferredPluginMigration(pending, params.env), {
        pluginId: pending.pluginId,
        reason: pending.reason,
        action: pending.command,
        status: "pending",
      });
    }
    for (const pluginId of transitions.resolved) {
      const settlement = params.settlements?.find((entry) => entry.pluginId === pluginId);
      log.info(
        `Deferred state migration ${settlement ? "settled" : "completed"} for plugin "${pluginId}".`,
        {
          pluginId,
          status: settlement?.status ?? "completed",
          ...(settlement ? { reason: settlement.reason } : {}),
        },
      );
    }
    return transitions.pending;
  });
}
