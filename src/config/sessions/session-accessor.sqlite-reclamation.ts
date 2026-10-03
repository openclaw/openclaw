import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  resolveOpenClawStateDirForDatabasePath,
  resolveOpenClawStateSqlitePath,
} from "../../state/openclaw-state-db.paths.js";
import { reclaimSessionArchivePublicationInTransaction } from "./session-accessor.sqlite-archive-transaction.js";
import type { MaterializedSessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import type {
  DeleteSessionEntryLifecycleParams,
  DeleteSessionEntryLifecycleResult,
} from "./session-accessor.sqlite-contract.js";
import {
  prepareSessionDeletionInDatabase,
  readValidatedSessionDeletionTarget,
} from "./session-accessor.sqlite-deletion-plan.js";
import { runSqliteSessionDeletionTransaction } from "./session-accessor.sqlite-deletion.js";
import type { SqliteLifecycleTargetSnapshot } from "./session-accessor.sqlite-entry-equality.js";
import {
  deleteLifecycleTargetRows,
  readSessionEntryCount,
} from "./session-accessor.sqlite-entry-store.js";
import {
  assertPlannedLifecycleArtifactEntriesUnchanged,
  deleteMaterializedSessionStatePlans,
  deletePlannedLifecycleArtifactEntries,
  projectSessionEntryLifecycleRemovalsInDatabase,
} from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionDeletionValidation,
  ReclamationDatabaseOptions,
  ReclamationDeleteParams,
  SessionEntryMaintenanceInput,
  SessionEntryRemovalPlan,
  SqliteSessionReclamationCallbacks,
  SqliteSessionReclamationPlan,
  SqliteSessionReclamationResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import { reclaimSessionMaintenanceInTransaction } from "./session-accessor.sqlite-maintenance-transaction.js";
import { deleteSessionDeliveryArtifacts } from "./session-accessor.sqlite-node-artifacts.js";
import { commitProjectedSessionEntryRemovalsInDatabase } from "./session-accessor.sqlite-projection-state.js";
import { isRecentHistoricalSessionId } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

type SessionBoardCleanupDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "board_tabs" | "board_widgets"
> & {
  sqlite_schema: { name: string | null; type: string };
};

const reclamationQueue = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteSessionReclamationQueue"),
  () => new KeyedAsyncQueue(),
);

/** Bounds materialized archive bytes through the matching reclamation commit. */
export function runExclusiveSqliteSessionReclamation<T>(run: () => Promise<T>): Promise<T> {
  return reclamationQueue.enqueue("session-reclamation", run);
}

export function resolveSessionReclamationDatabaseOptions(
  options: OpenClawAgentDatabaseOptions,
): ReclamationDatabaseOptions {
  const sourceEnv = options.env ?? process.env;
  const sharedStatePath = options.database?.path ?? resolveOpenClawStateSqlitePath(sourceEnv);
  return {
    agentId: normalizeAgentId(options.agentId),
    env: {
      OPENCLAW_STATE_DIR: resolveOpenClawStateDirForDatabasePath(sharedStatePath),
      ...(isGatewayExternallySupervised(sourceEnv) ? { OPENCLAW_SUPERVISOR_MODE: "external" } : {}),
    },
    path: resolveOpenClawAgentSqlitePath(options),
  };
}

function deleteSessionBoardRows(
  database: OpenClawAgentDatabase,
  sessionKeys: readonly string[],
): void {
  const keys = [...new Set(sessionKeys)];
  if (keys.length === 0) {
    return;
  }
  const db = getNodeSqliteKysely<SessionBoardCleanupDatabase>(database.db);
  const tables = new Set(
    executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "in", ["board_tabs", "board_widgets"]),
    ).rows.map((row) => row.name),
  );
  if (!tables.has("board_tabs") || !tables.has("board_widgets")) {
    return;
  }
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("board_widgets").where("session_key", "in", keys),
  );
  executeSqliteQuerySync(database.db, db.deleteFrom("board_tabs").where("session_key", "in", keys));
}

export function* prepareHistoricalGenerationDeletions(params: {
  deleteParams: DeleteSessionEntryLifecycleParams;
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  sessionIds: readonly string[];
}): Generator<SessionDeletionValidation & { sessionId: string }> {
  const expected = params.deleteParams.expectedGenerations
    ? new Map(
        params.deleteParams.expectedGenerations.map((generation) => [
          generation.window.session_id,
          generation,
        ]),
      )
    : undefined;
  for (const sessionId of params.sessionIds) {
    const generation = expected?.get(sessionId);
    yield {
      sessionId,
      deleteParams: expected
        ? { ...params.deleteParams, expectedGenerations: generation ? [generation] : [] }
        : params.deleteParams,
      preparedTargetSnapshot: params.preparedTargetSnapshot,
      scope: { kind: "historical-generation", phase: "plan", sessionId },
    };
  }
}

export function expectedEntryMismatchResult(
  archivedTranscripts: DeleteSessionEntryLifecycleResult["archivedTranscripts"] = [],
): DeleteSessionEntryLifecycleResult {
  return { archivedTranscripts, deleted: false, expectedEntryMismatch: true };
}

export function reclaimSqliteSessionInTransaction(
  plan: SqliteSessionReclamationPlan,
  callbacks: SqliteSessionReclamationCallbacks = {},
): SqliteSessionReclamationResult {
  if (plan.kind === "maintenance-pages") {
    const database = openOpenClawAgentDatabase(plan.databaseOptions);
    return {
      kind: plan.kind,
      value: database.walMaintenance.reclaimFreePages({
        maxPages: plan.maxPages,
        beforeMutation: callbacks.beforeMutation,
        onCommit: () => callbacks.onCommit?.(database),
        afterCommit: callbacks.afterCommit,
      }),
    };
  }
  const result = reclaimSqliteRowsInTransaction(plan, callbacks);
  callbacks.afterCommit?.();
  if (result.kind === "history-eviction" && result.value.deleted) {
    reclaimSqliteFreePagesBestEffort(plan.databaseOptions);
  }
  return result;
}

function reclaimSqliteRowsInTransaction(
  plan: Exclude<SqliteSessionReclamationPlan, { kind: "maintenance-pages" }>,
  callbacks: SqliteSessionReclamationCallbacks,
): SqliteSessionReclamationResult {
  if (plan.kind === "deletion-plan") {
    return runOpenClawAgentWriteTransaction(
      (database) => {
        callbacks.beforeMutation?.();
        const value = prepareSessionDeletionInDatabase(database, plan.planning);
        callbacks.onCommit?.(database);
        return { kind: plan.kind, value };
      },
      plan.databaseOptions,
      { operationLabel: "session.deletion.plan" },
    );
  }
  if (plan.kind === "lifecycle-projection-plan" || plan.kind === "lifecycle-projection-count") {
    return runOpenClawAgentWriteTransaction(
      (database) => {
        callbacks.beforeMutation?.();
        const result: SqliteSessionReclamationResult =
          plan.kind === "lifecycle-projection-plan"
            ? {
                kind: plan.kind,
                value: projectSessionEntryLifecycleRemovalsInDatabase(database, plan.input),
              }
            : { kind: plan.kind, value: readSessionEntryCount(database) };
        callbacks.onCommit?.(database);
        return result;
      },
      plan.databaseOptions,
      { operationLabel: "session.lifecycle.plan" },
    );
  }
  if (plan.kind === "lifecycle-projection-commit") {
    const value = runSqliteSessionDeletionTransaction(
      (database) => {
        callbacks.beforeMutation?.();
        const result = commitProjectedSessionEntryRemovalsInDatabase(
          database,
          plan.input,
          plan.materializedPlans,
        );
        callbacks.onCommit?.(database, { kind: plan.kind, value: result });
        return result;
      },
      plan.databaseOptions,
      { operationLabel: "session.lifecycle.mutate" },
    );
    return { kind: plan.kind, value };
  }
  if (plan.kind === "archive-publish-prepare" || plan.kind === "archive-publish-record") {
    return reclaimSessionArchivePublicationInTransaction(plan, callbacks);
  }
  if (
    plan.kind === "maintenance-plan" ||
    plan.kind === "maintenance-age" ||
    plan.kind === "maintenance-finalize" ||
    plan.kind === "maintenance-statistics"
  ) {
    return reclaimSessionMaintenanceInTransaction(plan, callbacks);
  }

  if (plan.kind === "entry") {
    const value = runSqliteSessionDeletionTransaction<DeleteSessionEntryLifecycleResult>(
      (transactionDb) => {
        callbacks.beforeMutation?.();
        const current = readValidatedSessionDeletionTarget(transactionDb, {
          ...plan,
          scope: { kind: "entry", phase: "commit" },
        });
        if (!current) {
          return expectedEntryMismatchResult();
        }
        const { snapshot, entry } = current;
        const sessionKeys = [
          plan.deleteParams.target.canonicalKey,
          ...plan.deleteParams.target.storeKeys,
          ...snapshot.map((row) => row.sessionKey),
        ];
        const archivedTranscripts = deleteMaterializedSessionStatePlans(
          transactionDb,
          plan.materializedPlans,
          undefined,
          new Set(sessionKeys),
        );
        deleteLifecycleTargetRows(transactionDb, plan.deleteParams.target);
        if (plan.deleteParams.deleteDeliveryArtifacts === true) {
          deleteSessionDeliveryArtifacts(
            transactionDb,
            plan.deleteParams.target.canonicalKey,
            sessionKeys,
          );
        }
        deleteSessionBoardRows(transactionDb, sessionKeys);
        callbacks.onCommit?.(transactionDb);
        return {
          archivedTranscripts,
          deleted: true,
          deletedEntry: structuredClone(entry),
          ...(entry.sessionId ? { deletedSessionId: entry.sessionId } : {}),
        };
      },
      plan.databaseOptions,
      { operationLabel: "session.reclaim.entry" },
    );
    return { kind: plan.kind, value };
  }

  if (plan.kind === "lifecycle-artifacts") {
    const value = runSqliteSessionDeletionTransaction(
      (transactionDb) => {
        callbacks.beforeMutation?.();
        assertPlannedLifecycleArtifactEntriesUnchanged(transactionDb, plan.entries);
        const archivedTranscripts = deleteMaterializedSessionStatePlans(
          transactionDb,
          plan.materializedPlans,
          undefined,
          new Set(plan.entries.map((entry) => entry.sessionKey)),
        );
        const removedEntries = deletePlannedLifecycleArtifactEntries(transactionDb, plan.entries);
        callbacks.onCommit?.(transactionDb);
        return { archivedTranscripts, removedEntries };
      },
      plan.databaseOptions,
      { operationLabel: "session.reclaim.lifecycle-artifacts" },
    );
    return { kind: plan.kind, value };
  }

  const value = runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      callbacks.beforeMutation?.();
      const protectedSessionIds = new Set(plan.protectedSessionIds);
      const diskBudget = plan.kind === "history-eviction" ? plan.diskBudget : undefined;
      let excludedSessionKeys: ReadonlySet<string> | undefined;
      if (plan.kind === "historical-generation") {
        const current = readValidatedSessionDeletionTarget(transactionDb, {
          ...plan,
          scope: { kind: "historical-generation", phase: "commit", sessionId: plan.sessionId },
        });
        if (!current) {
          return { archivedTranscripts: [], deleted: false, expectedEntryMismatch: true as const };
        }
        // Explicit deletion excludes its validated owner; automatic pressure does not.
        excludedSessionKeys = new Set([
          plan.deleteParams.target.canonicalKey,
          ...plan.deleteParams.target.storeKeys,
          ...current.snapshot.map((row) => row.sessionKey),
        ]);
      } else if (
        // Node activity can change after the parent dispatches the Worker.
        isRecentHistoricalSessionId({
          database: transactionDb,
          ...plan.diskBudget,
          sessionId: plan.sessionId,
        })
      ) {
        protectedSessionIds.add(plan.sessionId);
      }
      const archivedTranscripts = deleteMaterializedSessionStatePlans(
        transactionDb,
        plan.materializedPlans,
        protectedSessionIds,
        excludedSessionKeys,
        undefined,
        diskBudget,
      );
      const db = getSessionKysely(transactionDb.db);
      const deleted =
        executeSqliteQuerySync(
          transactionDb.db,
          db
            .selectFrom("session_windows")
            .select("session_id")
            .where("session_id", "=", plan.sessionId),
        ).rows.length === 0;
      if (deleted) {
        callbacks.onCommit?.(transactionDb);
      }
      return { archivedTranscripts: deleted ? archivedTranscripts : [], deleted };
    },
    plan.databaseOptions,
    { operationLabel: `session.reclaim.${plan.kind}` },
  );
  return { kind: plan.kind, value };
}

function reclaimSqliteFreePagesBestEffort(databaseOptions: ReclamationDatabaseOptions): void {
  try {
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.walMaintenance.reclaimFreePages({ checkpointMode: "PASSIVE" });
  } catch {
    // Deletion is already durable. The next budget pass can reclaim pages.
  }
}

// The live assertion belongs to runSqliteSessionReclamation, never its cloneable plan.
function prepareReclamationDeleteParams({
  commitGuard: _commitGuard,
  env: _env,
  descendantRunBasis: _descendantRunBasis,
  ...params
}: DeleteSessionEntryLifecycleParams): ReclamationDeleteParams {
  return params;
}

export function createSessionEntryReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  deleteParams: DeleteSessionEntryLifecycleParams;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
}): Extract<SqliteSessionReclamationPlan, { kind: "entry" }> {
  return {
    descendantRunBasis: params.deleteParams.descendantRunBasis,
    databaseOptions: resolveSessionReclamationDatabaseOptions(params.databaseOptions),
    deleteParams: prepareReclamationDeleteParams(params.deleteParams),
    kind: "entry",
    materializedPlans: params.materializedPlans,
    preparedTargetSnapshot: params.preparedTargetSnapshot,
  };
}

export function createLifecycleArtifactReclamationPlan(params: {
  agentId: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  entries: SessionEntryRemovalPlan[];
  materializedPlans: MaterializedSessionStateDeletePlan[];
}): Extract<SqliteSessionReclamationPlan, { kind: "lifecycle-artifacts" }> {
  return {
    databaseOptions: resolveSessionReclamationDatabaseOptions(params.databaseOptions),
    agentId: params.agentId,
    entries: params.entries,
    kind: "lifecycle-artifacts",
    materializedPlans: params.materializedPlans,
  };
}

export function createSessionMaintenancePlanningOperation(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  input: SessionEntryMaintenanceInput;
  ageOwner?: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "maintenance-plan" }> {
  return {
    databaseOptions: resolveSessionReclamationDatabaseOptions(params.databaseOptions),
    input: params.input,
    ageOwner: params.ageOwner,
    kind: "maintenance-plan",
    materializedPlans: [],
  };
}

export function createSessionMaintenanceStatisticsOperation(
  databaseOptions: OpenClawAgentDatabaseOptions,
): Extract<SqliteSessionReclamationPlan, { kind: "maintenance-statistics" }> {
  return {
    databaseOptions: resolveSessionReclamationDatabaseOptions(databaseOptions),
    kind: "maintenance-statistics",
    materializedPlans: [],
  };
}

export function createSessionMaintenanceFinalizationOperation(params: {
  agentId: string;
  databaseOptions: OpenClawAgentDatabaseOptions;
  entries: SessionEntryRemovalPlan[];
  materializedPlans: MaterializedSessionStateDeletePlan[];
}): Extract<SqliteSessionReclamationPlan, { kind: "maintenance-finalize" }> {
  return {
    ...params,
    databaseOptions: resolveSessionReclamationDatabaseOptions(params.databaseOptions),
    kind: "maintenance-finalize",
  };
}

export function createHistoryEvictionReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  diskBudget: { preserveRecentMs?: number | null };
  materializedPlans: MaterializedSessionStateDeletePlan[];
  protectedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "history-eviction" }> {
  return {
    databaseOptions: resolveSessionReclamationDatabaseOptions(params.databaseOptions),
    diskBudget: params.diskBudget,
    kind: "history-eviction",
    materializedPlans: params.materializedPlans,
    protectedSessionIds: [...params.protectedSessionIds],
    sessionId: params.sessionId,
  };
}

export function createHistoricalGenerationReclamationPlan(params: {
  databaseOptions: OpenClawAgentDatabaseOptions;
  deleteParams: DeleteSessionEntryLifecycleParams;
  materializedPlans: MaterializedSessionStateDeletePlan[];
  preparedTargetSnapshot: SqliteLifecycleTargetSnapshot;
  protectedSessionIds: ReadonlySet<string>;
  sessionId: string;
}): Extract<SqliteSessionReclamationPlan, { kind: "historical-generation" }> {
  return {
    descendantRunBasis: params.deleteParams.descendantRunBasis,
    databaseOptions: resolveSessionReclamationDatabaseOptions(params.databaseOptions),
    deleteParams: prepareReclamationDeleteParams(params.deleteParams),
    kind: "historical-generation",
    materializedPlans: params.materializedPlans,
    preparedTargetSnapshot: params.preparedTargetSnapshot,
    protectedSessionIds: [...params.protectedSessionIds],
    sessionId: params.sessionId,
  };
}
