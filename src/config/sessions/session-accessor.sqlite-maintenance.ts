import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getChildLogger } from "../../logging/logger.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  resolveOpenClawAgentSqlitePath,
  isIncognitoOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import {
  materializeSessionStateDeletePlans,
  runSqliteTranscriptArchiveWorkerOperation,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import { collectSessionStateIdsForEntry } from "./session-accessor.sqlite-lifecycle-state.js";
import type {
  SessionEntryMaintenancePlan,
  SessionEntryMaintenanceResult,
} from "./session-accessor.sqlite-lifecycle-types.js";
import {
  applySessionEntryMaintenanceInDatabase,
  emptySessionEntryMaintenancePlan,
  readSessionTranscriptJsonlBytesInDatabase,
} from "./session-accessor.sqlite-maintenance-store.js";
import {
  createSessionMaintenanceFinalizationOperation,
  createSessionMaintenanceStatisticsOperation,
  runSqliteSessionReclamation,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import { captureSessionMaintenancePreservation } from "./store-maintenance-preserve.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  normalizeResolvedMaintenanceConfigInput,
  type ResolvedSessionMaintenanceConfigInput,
} from "./store-maintenance.js";

// Live-entry pruning owner. Produces plans inside writes; finalizes archives afterward.

const MAX_SESSION_MAINTENANCE_BATCH_ENTRIES = 64;
const MAX_SESSION_MAINTENANCE_BATCH_ARCHIVE_BYTES = 64 * 1024 * 1024;
const SESSION_TRANSCRIPT_BYTE_QUERY_BATCH = MAX_SESSION_MAINTENANCE_BATCH_ENTRIES;
// One full maintenance batch is the bulk-deletion boundary. Smaller routine
// cleanups must not pay the measured synchronous full-database analysis cost.
const SESSION_PLANNER_ANALYSIS_MIN_DELETED_ENTRIES = MAX_SESSION_MAINTENANCE_BATCH_ENTRIES;
const plannerMaintenanceByStore = new Map<string, Promise<void>>();

/** Coalesce bounded planner-statistics refreshes behind the per-store writer lane. */
export async function refreshSqliteSessionPlannerStatisticsBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  deletedEntries: number,
  options: { isCurrent?: () => boolean } = {},
): Promise<void> {
  const isCurrent = options.isCurrent ?? (() => true);
  if (deletedEntries < SESSION_PLANNER_ANALYSIS_MIN_DELETED_ENTRIES || !isCurrent()) {
    return;
  }
  const storePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const active = plannerMaintenanceByStore.get(storePath);
  if (active) {
    await active;
    return;
  }
  const completion = runSqliteSessionReclamation({
    diagnostics: { kind: "maintenance-statistics" },
    assertCommitAllowed: () => {
      if (!isCurrent()) {
        throw new Error("SQLite maintenance planner owner retired");
      }
    },
    forceInProcess: false,
    plan: createSessionMaintenanceStatisticsOperation(toDatabaseOptions(scope)),
  })
    .then(() => undefined)
    .catch((error: unknown) => {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "SQLite session planner-statistics refresh failed",
        { agentId: scope.agentId, error, path: storePath },
      );
    })
    .finally(() => {
      plannerMaintenanceByStore.delete(storePath);
    });
  plannerMaintenanceByStore.set(storePath, completion);
  await completion;
}

type SessionMaintenanceBatch = {
  archiveBytes: number;
  entryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
  stateDeletePlans: SessionStateDeletePlan[];
  workItems: number;
};

function buildSessionMaintenanceBatches(params: {
  archiveBytesBySessionId: ReadonlyMap<string, number>;
  entryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
  stateDeletePlans: readonly SessionStateDeletePlan[];
}): SessionMaintenanceBatch[] {
  const parent = params.entryRemovals.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) {
      root = parent[root] ?? root;
    }
    let current = index;
    while (parent[current] !== current) {
      const next = parent[current] ?? root;
      parent[current] = root;
      current = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  const removalIndexBySessionId = new Map<string, number>();
  const removalIndexBySessionKey = new Map<string, number>();
  const addRemovalIndex = (sessionId: string, index: number): void => {
    const firstIndex = removalIndexBySessionId.get(sessionId);
    if (firstIndex === undefined) {
      removalIndexBySessionId.set(sessionId, index);
    } else {
      union(firstIndex, index);
    }
  };
  for (const [index, removal] of params.entryRemovals.entries()) {
    if (!removal.expectedEntry) {
      continue;
    }
    removalIndexBySessionKey.set(removal.sessionKey, index);
    for (const sessionId of collectSessionStateIdsForEntry(removal.expectedEntry)) {
      addRemovalIndex(sessionId, index);
    }
  }
  for (const plan of params.stateDeletePlans) {
    const ownerIndex = plan.snapshot.sessionKey
      ? removalIndexBySessionKey.get(plan.snapshot.sessionKey)
      : undefined;
    if (ownerIndex !== undefined) {
      addRemovalIndex(plan.sessionId, ownerIndex);
    }
  }

  const groupsByRoot = new Map<number, SessionMaintenanceBatch & { order: number }>();
  for (const [index, removal] of params.entryRemovals.entries()) {
    const root = find(index);
    const group = groupsByRoot.get(root) ?? {
      archiveBytes: 0,
      entryRemovals: [],
      order: index,
      stateDeletePlans: [],
      workItems: 0,
    };
    group.entryRemovals.push(removal);
    group.order = Math.min(group.order, index);
    groupsByRoot.set(root, group);
  }

  const plansBySessionId = new Map<string, SessionStateDeletePlan[]>();
  for (const plan of params.stateDeletePlans) {
    const plans = plansBySessionId.get(plan.sessionId) ?? [];
    plans.push(plan);
    plansBySessionId.set(plan.sessionId, plans);
  }
  const standaloneGroups: Array<SessionMaintenanceBatch & { order: number }> = [];
  let standaloneOrder = params.entryRemovals.length;
  for (const [sessionId, plans] of plansBySessionId) {
    const removalIndex = removalIndexBySessionId.get(sessionId);
    const removalGroup =
      removalIndex === undefined ? undefined : groupsByRoot.get(find(removalIndex));
    const group = removalGroup ?? {
      archiveBytes: 0,
      entryRemovals: [],
      order: standaloneOrder++,
      stateDeletePlans: [],
      workItems: 0,
    };
    group.stateDeletePlans.push(...plans);
    if (plans.some((plan) => plan.archiveTranscript)) {
      group.archiveBytes += params.archiveBytesBySessionId.get(sessionId) ?? 0;
    }
    if (!removalGroup) {
      standaloneGroups.push(group);
    }
  }

  const groups = [...groupsByRoot.values(), ...standaloneGroups]
    .map((group) => {
      group.workItems = Math.max(
        group.entryRemovals.length,
        new Set(group.stateDeletePlans.map((plan) => plan.sessionId)).size,
      );
      return group;
    })
    .toSorted((left, right) => left.order - right.order);
  const batches: SessionMaintenanceBatch[] = [];
  let batch: SessionMaintenanceBatch = {
    archiveBytes: 0,
    entryRemovals: [],
    stateDeletePlans: [],
    workItems: 0,
  };
  const flush = (): void => {
    if (batch.workItems === 0) {
      return;
    }
    batches.push(batch);
    batch = { archiveBytes: 0, entryRemovals: [], stateDeletePlans: [], workItems: 0 };
  };
  // Limits apply between ownership groups. One inseparable group may exceed them so shared or
  // historical session state is never deleted in a different transaction from its last owner.
  for (const group of groups) {
    const exceedsEntryLimit =
      batch.workItems > 0 &&
      batch.workItems + group.workItems > MAX_SESSION_MAINTENANCE_BATCH_ENTRIES;
    const exceedsByteLimit =
      batch.workItems > 0 &&
      batch.archiveBytes + group.archiveBytes > MAX_SESSION_MAINTENANCE_BATCH_ARCHIVE_BYTES;
    if (exceedsEntryLimit || exceedsByteLimit) {
      flush();
    }
    batch.archiveBytes += group.archiveBytes;
    batch.entryRemovals.push(...group.entryRemovals);
    batch.stateDeletePlans.push(...group.stateDeletePlans);
    batch.workItems += group.workItems;
  }
  flush();
  return batches;
}

async function readSessionTranscriptJsonlBytes(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  sessionIds: readonly string[],
  isCurrent: () => boolean,
): Promise<Map<string, number>> {
  const bytesBySessionId = new Map<string, number>();
  const options = resolveSessionReclamationDatabaseOptions(toDatabaseOptions(scope));
  for (let offset = 0; offset < sessionIds.length; offset += SESSION_TRANSCRIPT_BYTE_QUERY_BATCH) {
    const batch = sessionIds.slice(offset, offset + SESSION_TRANSCRIPT_BYTE_QUERY_BATCH);
    // Give queued writers a turn between bounded read-only sizing batches.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    if (!isCurrent()) {
      return bytesBySessionId;
    }
    let sized: Map<string, number>;
    if (isIncognitoOpenClawAgentSqlitePath(options.path, options)) {
      const opened = withOpenClawAgentDatabaseReadOnly(
        (database) => readSessionTranscriptJsonlBytesInDatabase(database, batch),
        options,
      );
      if (!opened.found) {
        throw new Error(
          `Cannot size SQLite session transcripts: ${opened.reason.replaceAll("-", " ")}`,
        );
      }
      sized = opened.value;
    } else {
      const results = await withSqliteMutationWorkerLifetime(
        options,
        async ({ assertCurrent, signal }) =>
          await runSqliteTranscriptArchiveWorkerOperation<Map<string, number>>({
            assertCurrent,
            signal,
            expectedMessageType: "sized",
            workerData: {
              type: "sqlite-transcript-archive-v2",
              operation: "maintenance-size",
              input: { ...options, sessionIds: batch },
            },
          }),
      );
      if (!results[0]) {
        throw new Error("SQLite maintenance sizing worker omitted its result");
      }
      sized = results[0];
    }
    if (!isCurrent()) {
      return bytesBySessionId;
    }
    for (const [sessionId, bytes] of sized) {
      bytesBySessionId.set(sessionId, bytes);
    }
  }
  return bytesBySessionId;
}

export function applySessionEntryMaintenance(
  database: OpenClawAgentDatabase,
  params: {
    activeSessionKey?: string;
    activeSessionKeys?: readonly string[];
    archiveDirectory: string;
    forceMaintenance?: boolean;
    maintenanceConfig?: ResolvedSessionMaintenanceConfigInput;
    skipMaintenance?: boolean;
    storePath: string;
  },
): SessionEntryMaintenancePlan {
  if (params.skipMaintenance) {
    return emptySessionEntryMaintenancePlan();
  }
  const maintenance = params.maintenanceConfig
    ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
    : resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return emptySessionEntryMaintenancePlan();
  }
  return applySessionEntryMaintenanceInDatabase(database, { ...params, maintenance }, () =>
    captureSessionMaintenancePreservation(params.storePath),
  );
}

/** Finalizes maintenance after its caller releases the per-store writer lane. */
export async function finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SessionEntryMaintenancePlan[],
  options: { deletedEntriesBeforeMaintenance?: number; isCurrent?: () => boolean } = {},
): Promise<SessionEntryMaintenanceResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  const committedCounts = {
    archived: plans.reduce((count, plan) => count + plan.archived, 0),
    capArchived: plans.reduce((count, plan) => count + plan.capArchived, 0),
    modelRunPruned: 0,
    pruned: 0,
    capped: plans.reduce(
      (count, plan) =>
        count +
        plan.capped -
        plan.entryRemovals.filter((removal) => removal.maintenanceReason === "capped").length,
      0,
    ),
  };
  const emptyResult = () => ({ archivedTranscripts: [], ...committedCounts });
  if (!isCurrent()) {
    return emptyResult();
  }
  const archivedWorktrees = plans.flatMap((plan) => plan.archivedWorktrees ?? []);
  if (archivedWorktrees.length) {
    const { cleanUpAutomaticallyArchivedWorktrees } =
      await import("../../sessions/session-worktree-lifecycle.js");
    if (!isCurrent()) {
      return emptyResult();
    }
    await cleanUpAutomaticallyArchivedWorktrees(scope, archivedWorktrees);
  }
  const entryRemovals = plans.flatMap((plan) => plan.entryRemovals);
  const stateDeletePlans = plans.flatMap((plan) => plan.stateDeletePlans);
  const warn = (
    message: string,
    error: unknown,
    warnedStateDeletePlans: readonly SessionStateDeletePlan[],
  ) => {
    getChildLogger({ subsystem: "session-sqlite" }).warn(message, {
      agentId: scope.agentId,
      error,
      path: scope.path,
      sessionIds: uniqueStrings(warnedStateDeletePlans.map((plan) => plan.sessionId)),
    });
  };
  if (!isCurrent()) {
    return emptyResult();
  }
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    await refreshSqliteSessionPlannerStatisticsBestEffort(
      scope,
      options.deletedEntriesBeforeMaintenance ?? 0,
      { isCurrent },
    );
    return emptyResult();
  }
  let archiveBytesBySessionId: Map<string, number>;
  try {
    archiveBytesBySessionId = await readSessionTranscriptJsonlBytes(
      scope,
      stateDeletePlans.filter((plan) => plan.archiveTranscript).map((plan) => plan.sessionId),
      isCurrent,
    );
  } catch (error) {
    warn("SQLite session maintenance archive sizing failed", error, stateDeletePlans);
    await refreshSqliteSessionPlannerStatisticsBestEffort(
      scope,
      options.deletedEntriesBeforeMaintenance ?? 0,
      { isCurrent },
    );
    return emptyResult();
  }
  if (!isCurrent()) {
    return emptyResult();
  }
  const publishedTranscripts: SessionLifecycleArchivedTranscript[] = [];
  let deletedEntries = options.deletedEntriesBeforeMaintenance ?? 0;
  for (const batch of buildSessionMaintenanceBatches({
    archiveBytesBySessionId,
    entryRemovals,
    stateDeletePlans,
  })) {
    if (!isCurrent()) {
      break;
    }
    let archivedTranscripts: SessionLifecycleArchivedTranscript[];
    let changedEntryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
    let committedEntryRemovals: SessionEntryMaintenancePlan["entryRemovals"];
    try {
      const materializedPlans = await materializeSessionStateDeletePlans(batch.stateDeletePlans);
      if (!isCurrent()) {
        break;
      }
      const result = await withSqliteSessionDeletions(
        scope,
        batch.entryRemovals.flatMap(({ expectedEntry: entry, sessionKey }) =>
          entry ? [{ entry, sessionKey }] : [],
        ),
        async (assertCurrent) =>
          await runSqliteSessionReclamation({
            diagnostics: { kind: "maintenance-finalize" },
            assertCommitAllowed: () => {
              assertCurrent();
              if (!isCurrent()) {
                throw new Error("SQLite automatic maintenance owner retired");
              }
            },
            forceInProcess: hasPreparedNativeSessionDeletion(),
            plan: createSessionMaintenanceFinalizationOperation({
              agentId: scope.agentId,
              databaseOptions: toDatabaseOptions(scope),
              entries: batch.entryRemovals,
              materializedPlans,
            }),
          }),
      );
      if (result.kind !== "maintenance-finalize") {
        throw new Error("SQLite maintenance returned another operation's result");
      }
      archivedTranscripts = result.value.archivedTranscripts;
      changedEntryRemovals = result.value.changedEntries;
      committedEntryRemovals = result.value.committedEntries;
    } catch (error) {
      warn("SQLite session maintenance cleanup failed", error, batch.stateDeletePlans);
      break;
    }
    if (!isCurrent()) {
      break;
    }
    if (changedEntryRemovals.length > 0) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "SQLite session maintenance skipped changed entries",
        {
          agentId: scope.agentId,
          path: scope.path,
          sessionKeys: changedEntryRemovals.map((removal) => removal.sessionKey),
        },
      );
    }
    deletedEntries +=
      batch.workItems - (batch.entryRemovals.length - committedEntryRemovals.length);
    for (const removal of committedEntryRemovals) {
      if (removal.maintenanceReason === "model-run-pruned") {
        committedCounts.modelRunPruned += 1;
      } else if (removal.maintenanceReason === "pruned") {
        committedCounts.pruned += 1;
      } else if (removal.maintenanceReason === "capped") {
        committedCounts.capped += 1;
      }
    }
    try {
      publishedTranscripts.push(...(await publishSessionStateArchives(scope, archivedTranscripts)));
    } catch (error) {
      warn("SQLite session maintenance archive publication failed", error, batch.stateDeletePlans);
    }
  }
  if (isCurrent()) {
    await refreshSqliteSessionPlannerStatisticsBestEffort(scope, deletedEntries, { isCurrent });
  }
  return { archivedTranscripts: publishedTranscripts, ...committedCounts };
}
