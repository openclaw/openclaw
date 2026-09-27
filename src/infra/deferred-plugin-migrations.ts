import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import {
  isArtifactPreservingStateRead,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { withSharedStateWriteCoordinator } from "../state/openclaw-state-db-write-coordination.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { isTruthyEnvValue } from "./env.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { invalidateSuccessfulMigrationCheckpointsInTransaction } from "./startup-migration-checkpoint.js";
import { recordLegacyMigrationRun } from "./state-migrations.receipts.js";

const RUN_PREFIX = "deferred-plugin-migration:";
const deferredPluginMigrationSchema = z.object({
  pluginId: z.string().min(1),
  reason: z.string().min(1),
  command: z.string().min(1),
  requiresStateMigration: z.literal(true).optional(),
  requiresDoctorInspection: z.literal(true).optional(),
  configPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
  validationExcludedPaths: z.array(z.array(z.string().min(1)).min(1)).optional(),
});

export type DeferredPluginMigration = z.infer<typeof deferredPluginMigrationSchema>;

export class DeferredPluginMigrationConflictError extends Error {
  readonly pending: readonly DeferredPluginMigration[];

  constructor(pending: readonly DeferredPluginMigration[]) {
    super(
      'Plugin migration obligations changed while their inputs were being prepared. Retained inputs remain protected; run "openclaw doctor --fix" after the other repair finishes.',
    );
    this.name = "DeferredPluginMigrationConflictError";
    this.pending = pending;
  }
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

function readPendingMigrationRows(database: DatabaseSync) {
  return executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<Pick<DB, "migration_runs">>(database)
      .selectFrom("migration_runs")
      .select(["id", "report_json"])
      .where("id", "like", `${RUN_PREFIX}%`)
      .where("status", "=", "pending")
      .orderBy("id"),
  ).rows;
}

function pendingMigrationRecords(rows: ReturnType<typeof readPendingMigrationRows>) {
  return rows.map((row) => deferredPluginMigrationSchema.parse(JSON.parse(row.report_json)));
}

function readPendingMigrationRecords(database: DatabaseSync) {
  return tableExists(database, "migration_runs")
    ? pendingMigrationRecords(readPendingMigrationRows(database))
    : [];
}

function assertPendingGeneration(
  current: readonly DeferredPluginMigration[],
  expected: readonly DeferredPluginMigration[],
): void {
  if (!isDeepStrictEqual(current, expected)) {
    throw new DeferredPluginMigrationConflictError(current);
  }
}

export function readDeferredPluginMigrations(
  options: {
    path?: string;
    env?: NodeJS.ProcessEnv;
    artifactPreservingReadOnly?: boolean;
  } = {},
): readonly DeferredPluginMigration[] {
  const read =
    options.artifactPreservingReadOnly === false
      ? withExistingOpenClawStateDatabaseReadOnly
      : withExistingOpenClawStateDatabaseArtifactPreservingReadOnly;
  return read(({ db }) => readPendingMigrationRecords(db), options) ?? [];
}

/** Keep asynchronous config inspection off the main thread without creating state. */
export async function readDeferredPluginMigrationsAsync(
  options: Parameters<typeof readDeferredPluginMigrations>[0] = {},
): Promise<readonly DeferredPluginMigration[]> {
  const context = captureOpenClawStateWorkerContext(options);
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  context.admission.assertCurrent();
  const pending = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "plugins.deferredMigrations.read",
        input: {
          artifactPreservingReadOnly:
            options.artifactPreservingReadOnly !== false || isArtifactPreservingStateRead(),
        },
      }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return pending ?? [];
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
          .where("status", "=", "completed"),
      ).rows.flatMap(({ id, finished_at }) =>
        finished_at === null
          ? []
          : [{ pluginId: id.slice(RUN_PREFIX.length), completedAtMs: finished_at }],
      );
    }, options) ?? []
  );
}

export async function readDeferredPluginMigrationCompletionsAsync(
  options: Parameters<typeof readDeferredPluginMigrations>[0] = {},
) {
  const context = captureOpenClawStateWorkerContext(options);
  const { runOpenClawStateWorkerOperation } =
    await import("../state/openclaw-state-worker-store.js");
  context.admission.assertCurrent();
  const completed = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({ type: "plugins.deferredMigrations.completions.read", input: undefined }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return completed ?? [];
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
    expectedPending: readonly DeferredPluginMigration[];
    onConflict?: (pending: readonly DeferredPluginMigration[]) => T;
  },
  publish: () => T,
): T {
  const databasePath = resolveOpenClawStateSqlitePath(params.env);
  const existing = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(databasePath);
  return withSharedStateWriteCoordinator({ databasePath, existing: existing?.db }, () => {
    // Exclude obligation writers without bootstrapping or migrating unrelated state.
    if (params.expectedPending.length === 0 && !existing?.db.isTransaction) {
      const pending = withExistingOpenClawStateDatabaseCurrentReadOnly(
        ({ db }) => readPendingMigrationRecords(db),
        params,
      );
      if (!pending?.length) {
        return publish();
      }
    }
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const pending = pendingMigrationRecords(readPendingMigrationRows(db));
        if (!isDeepStrictEqual(pending, params.expectedPending) && params.onConflict) {
          // Commit preservation facts against these rows; callers refuse publication after return.
          return params.onConflict(pending);
        }
        assertPendingGeneration(pending, params.expectedPending);
        return publish();
      },
      { env: params.env },
      { operationLabel: "state.plugin-migration-input-publication" },
    );
  });
}

export function formatDeferredPluginMigration(
  pending: DeferredPluginMigration,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const retry = pending.command === "openclaw doctor --fix" ? "" : ', then "openclaw doctor --fix"';
  const updating =
    isTruthyEnvValue(env.OPENCLAW_UPDATE_IN_PROGRESS) ||
    isTruthyEnvValue(env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE);
  const next = updating
    ? `Let the current update or repair finish. If this warning remains afterward, run "${pending.command}"${retry} to retry the upgrade.`
    : `Run "${pending.command}"${retry} to retry the upgrade.`;
  return `Plugin "${pending.pluginId}" data/settings upgrade is unfinished: ${pending.reason} Your existing data and settings have been kept. ${next}`;
}

export type DeferredPluginMigrationRecordInput = {
  env?: NodeJS.ProcessEnv;
  pending: readonly DeferredPluginMigration[];
  resolvedPluginIds?: readonly string[];
  expectedPending?: readonly DeferredPluginMigration[];
};

/** Native row transform; the worker owns its transaction and lease grants. */
export function recordDeferredPluginMigrationsInTransaction(
  db: DatabaseSync,
  params: Omit<DeferredPluginMigrationRecordInput, "env">,
) {
  const pendingById = new Map(
    params.pending.map((pending) => [
      pending.pluginId,
      deferredPluginMigrationSchema.parse(pending),
    ]),
  );
  const currentRows = readPendingMigrationRows(db);
  if (params.expectedPending) {
    assertPendingGeneration(pendingMigrationRecords(currentRows), params.expectedPending);
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
    if (previous?.report_json === reportJson) {
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
  for (const pluginId of new Set(params.resolvedPluginIds)) {
    const runId = `${RUN_PREFIX}${pluginId}`;
    const previous = rows.get(runId);
    if (pendingById.has(pluginId) || !previous) {
      continue;
    }
    recordLegacyMigrationRun(db, {
      runId,
      startedAt: now,
      finishedAt: now,
      status: "completed",
      reportJson: previous.report_json,
      upsert: true,
    });
    resolved.push(pluginId);
  }
  if (deferred.length > 0) {
    invalidateSuccessfulMigrationCheckpointsInTransaction(db);
  }
  return { deferred, resolved, pending: pendingMigrationRecords(readPendingMigrationRows(db)) };
}

/** Only the migration owner can resolve a pending record after its work completes. */
export async function recordDeferredPluginMigrations(
  params: DeferredPluginMigrationRecordInput,
): Promise<readonly DeferredPluginMigration[] | undefined> {
  if (params.pending.length === 0 && !params.resolvedPluginIds?.length) {
    return undefined;
  }
  const input = structuredClone({
    pending: params.pending,
    resolvedPluginIds: params.resolvedPluginIds,
    expectedPending: params.expectedPending,
  });
  const { withPluginLifecycleLease } = await import("../plugins/plugin-lifecycle-lease.js");
  const { runWithOpenClawStateLeaseWorker } =
    await import("../state/openclaw-state-lease-worker-storage.js");
  return withPluginLifecycleLease({ env: params.env }, async (lease) => {
    const context = captureOpenClawStateWorkerContext({
      env: params.env,
      path: lease.databasePath,
    });
    const result = await runWithOpenClawStateLeaseWorker(
      lease.stateLease,
      context,
      (scope, identity) =>
        scope.execute({
          type: "plugins.deferredMigrations.record",
          input: {
            identity,
            ...input,
          },
        }),
      { assertCurrent: () => lease.assertCurrent() },
    );
    if (result.kind === "conflict") {
      throw new DeferredPluginMigrationConflictError(result.pending);
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
      log.info(`Deferred state migration completed for plugin "${pluginId}".`, {
        pluginId,
        status: "completed",
      });
    }
    return transitions.pending;
  });
}
