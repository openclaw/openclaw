import { expectDefined } from "@openclaw/normalization-core/expect";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getChildLogger } from "../../logging/logger.js";
import {
  resolveOpenClawAgentSqlitePath,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { publishSessionStateArchives } from "./session-accessor.sqlite-archive-store.js";
import type { SessionStateDeletePlan } from "./session-accessor.sqlite-archive-types.js";
import {
  materializeSessionStateDeletePlans,
  runSqliteTranscriptArchiveWorkerOperation,
} from "./session-accessor.sqlite-archive.js";
import type { SessionLifecycleArchivedTranscript } from "./session-accessor.sqlite-contract.js";
import {
  hasPreparedNativeSessionDeletion,
  preparedSessionDeletionRequiresNativeTransaction,
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
} from "./session-accessor.sqlite-maintenance-store.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import {
  createSessionMaintenanceFinalizationOperation,
  createSessionMaintenanceStatisticsOperation,
  resolveSessionReclamationDatabaseOptions,
} from "./session-accessor.sqlite-reclamation.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import { withSqliteMutationWorkerLifetime } from "./session-accessor.sqlite-worker-request.js";
import { captureSessionActorStorageOwner } from "./session-actor-storage-binding.js";
import { readSessionActorStorageResult } from "./session-actor-storage-result.js";
import {
  finalizeSessionMaintenanceInWorker,
  readSessionMaintenanceArchiveSizesInWorker,
  refreshSessionMaintenanceStatisticsInWorker,
} from "./session-maintenance-finalization.js";
import type { SessionMaintenancePreservationSnapshot } from "./store-maintenance-preserve-snapshot.types.js";
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
  options: { isCurrent?: () => boolean; retainedExecution?: OpenClawAgentDatabaseExecution } = {},
): Promise<void> {
  const isCurrent = options.isCurrent ?? (() => true);
  if (deletedEntries < SESSION_PLANNER_ANALYSIS_MIN_DELETED_ENTRIES || !isCurrent()) {
    return;
  }
  // Private stores have no persistent planner statistics or pages to maintain.
  if (
    captureSessionActorStorageOwner(
      { ...scope, storePath: scope.path },
      { assertCurrent() {}, authorize() {} },
    )
  ) {
    return;
  }
  const storePath = resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  const active = plannerMaintenanceByStore.get(storePath);
  if (active) {
    await active;
    return;
  }
  const assertCurrent = () => {
    options.retainedExecution?.assertCurrent();
    if (!isCurrent()) {
      throw new Error("SQLite maintenance planner owner retired");
    }
  };
  const refresh = options.retainedExecution
    ? refreshSessionMaintenanceStatisticsInWorker(
        resolveSessionReclamationDatabaseOptions(toDatabaseOptions(scope)),
        options.retainedExecution,
        assertCurrent,
      )
    : runSqliteSessionReclamation({
        diagnostics: { kind: "maintenance-statistics" },
        assertCommitAllowed: assertCurrent,
        forceInProcess: false,
        plan: createSessionMaintenanceStatisticsOperation(toDatabaseOptions(scope)),
      });
  const completion = refresh
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
  retainedExecution?: OpenClawAgentDatabaseExecution,
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
    if (retainedExecution) {
      sized = await readSessionMaintenanceArchiveSizesInWorker(
        options,
        batch,
        retainedExecution,
        () => {
          retainedExecution.assertCurrent();
          if (!isCurrent()) {
            throw new Error("SQLite automatic maintenance owner retired");
          }
        },
      );
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
    preservation?: () => SessionMaintenancePreservationSnapshot;
    refreshCandidates?: (sessionKeys: readonly string[]) => SessionMaintenancePreservationSnapshot;
    storePath: string;
  },
): SessionEntryMaintenancePlan {
  if (!params.preservation) {
    return emptySessionEntryMaintenancePlan();
  }
  const maintenance = params.maintenanceConfig
    ? normalizeResolvedMaintenanceConfigInput(params.maintenanceConfig)
    : resolveMaintenanceConfig();
  if (maintenance.mode === "warn") {
    return emptySessionEntryMaintenancePlan();
  }
  return applySessionEntryMaintenanceInDatabase(
    database,
    { ...params, maintenance },
    params.preservation,
    undefined,
    params.refreshCandidates,
  );
}

/** Finalizes maintenance after its caller releases the per-store writer lane. */
export async function finalizeSessionEntryMaintenancePlansAfterWriterReleaseBestEffort(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  plans: readonly SessionEntryMaintenancePlan[],
  options: {
    deletedEntriesBeforeMaintenance?: number;
    isCurrent?: () => boolean;
    retainedExecution?: OpenClawAgentDatabaseExecution;
    publishArchives?: (
      requested: readonly SessionLifecycleArchivedTranscript[],
    ) => Promise<SessionLifecycleArchivedTranscript[]>;
  } = {},
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
  const authority = {
    assertCurrent() {
      if (!isCurrent()) {
        throw new Error("Session maintenance owner retired");
      }
    },
    authorize() {},
  };
  const memory = captureSessionActorStorageOwner({ ...scope, storePath: scope.path }, authority);
  if (memory) {
    const owner = memory.owner;
    if (!owner || entryRemovals.length === 0) {
      return emptyResult();
    }
    try {
      if (stateDeletePlans.some((plan) => plan.archiveTranscript)) {
        throw new Error("Incognito session maintenance cannot archive transcripts");
      }
      const first = owner.listSessionEntries(memory.authority, "list")[0];
      if (!first) {
        return emptyResult();
      }
      const actor = await owner.acquireExisting(first.sessionKey, {
        assertCurrent: authority.assertCurrent,
        assertReadable: authority.assertCurrent,
      });
      if (!actor) {
        return emptyResult();
      }
      try {
        const entries = entryRemovals.flatMap(({ expectedEntry, sessionKey }) =>
          expectedEntry ? [{ sessionKey, entry: expectedEntry }] : [],
        );
        const removed = await withSqliteSessionDeletions(
          { ...scope, agentId: memory.agentId, path: memory.path },
          entries,
          async (assertDeletionCurrent, capture, settleReceipts) => {
            let settlement: ReturnType<typeof capture> | undefined;
            const outcome = await actor.storage!.mutate(
              {
                type: "session.lifecycle.reclaim",
                input: {
                  entries: entries.map(({ sessionKey, entry }) => ({
                    sessionKey,
                    expected: entry,
                  })),
                },
              },
              {
                ...memory.authority,
                assertCurrent() {
                  memory.authority.assertCurrent();
                  assertDeletionCurrent();
                },
              },
              {
                beforeCommit(receipt) {
                  const removedKeys = new Set(receipt.value.removedSessionKeys);
                  settlement = capture(
                    entries.filter(({ sessionKey }) => removedKeys.has(sessionKey)),
                  );
                  settlement.beforeCommit();
                },
              },
            );
            settlement?.settle(outcome.kind);
            const result = readSessionActorStorageResult(outcome);
            if (result.removedSessionKeys.length > 0) {
              await settleReceipts(() => owner.assertCurrent());
            }
            return new Set(result.removedSessionKeys);
          },
          { memory: owner },
        );
        for (const removal of entryRemovals) {
          if (!removed.has(removal.sessionKey)) {
            continue;
          }
          if (removal.maintenanceReason === "model-run-pruned") {
            committedCounts.modelRunPruned += 1;
          } else if (removal.maintenanceReason === "pruned") {
            committedCounts.pruned += 1;
          } else if (removal.maintenanceReason === "capped") {
            committedCounts.capped += 1;
          }
        }
      } finally {
        await actor.release();
      }
    } catch (error) {
      warn("Memory session maintenance cleanup failed", error, stateDeletePlans);
    }
    return emptyResult();
  }
  if (entryRemovals.length === 0 && stateDeletePlans.length === 0) {
    await refreshSqliteSessionPlannerStatisticsBestEffort(
      scope,
      options.deletedEntriesBeforeMaintenance ?? 0,
      { isCurrent, retainedExecution: options.retainedExecution },
    );
    return emptyResult();
  }
  let archiveBytesBySessionId: Map<string, number>;
  try {
    archiveBytesBySessionId = await readSessionTranscriptJsonlBytes(
      scope,
      stateDeletePlans.filter((plan) => plan.archiveTranscript).map((plan) => plan.sessionId),
      isCurrent,
      options.retainedExecution,
    );
  } catch (error) {
    warn("SQLite session maintenance archive sizing failed", error, stateDeletePlans);
    await refreshSqliteSessionPlannerStatisticsBestEffort(
      scope,
      options.deletedEntriesBeforeMaintenance ?? 0,
      { isCurrent, retainedExecution: options.retainedExecution },
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
    let removalOutcomes: Array<
      Pick<SessionEntryMaintenancePlan["entryRemovals"][number], "sessionKey" | "maintenanceReason">
    > = [];
    let changedEntryRemovals: typeof removalOutcomes;
    let committedEntryRemovals: typeof removalOutcomes;
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
        async (assertCurrent) => {
          const assertCommitAllowed = () => {
            options.retainedExecution?.assertCurrent();
            assertCurrent();
            if (!isCurrent()) {
              throw new Error("SQLite automatic maintenance owner retired");
            }
          };
          removalOutcomes = batch.entryRemovals.map(({ sessionKey, maintenanceReason }) => ({
            sessionKey,
            maintenanceReason,
          }));
          const plan = createSessionMaintenanceFinalizationOperation({
            agentId: scope.agentId,
            databaseOptions: toDatabaseOptions(scope),
            entries: batch.entryRemovals,
            materializedPlans,
          });
          return options.retainedExecution && !preparedSessionDeletionRequiresNativeTransaction()
            ? finalizeSessionMaintenanceInWorker(
                plan,
                options.retainedExecution,
                assertCommitAllowed,
              )
            : runSqliteSessionReclamation({
                diagnostics: { kind: "maintenance-finalize" },
                assertCommitAllowed,
                forceInProcess: hasPreparedNativeSessionDeletion(),
                plan,
              });
        },
      );
      if (result.kind !== "maintenance-finalize") {
        throw new Error("SQLite maintenance returned another operation's result");
      }
      archivedTranscripts = result.value.archivedTranscripts;
      const committedIndices = new Set(result.value.committedEntryIndices);
      changedEntryRemovals = removalOutcomes.filter((_, index) => !committedIndices.has(index));
      committedEntryRemovals = result.value.committedEntryIndices.map((index) =>
        expectDefined(removalOutcomes[index], "Missing committed maintenance entry"),
      );
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
      publishedTranscripts.push(
        ...(await (options.publishArchives
          ? options.publishArchives(archivedTranscripts)
          : publishSessionStateArchives(scope, archivedTranscripts))),
      );
    } catch (error) {
      warn("SQLite session maintenance archive publication failed", error, batch.stateDeletePlans);
    }
  }
  if (isCurrent()) {
    await refreshSqliteSessionPlannerStatisticsBestEffort(scope, deletedEntries, {
      isCurrent,
      retainedExecution: options.retainedExecution,
    });
  }
  return { archivedTranscripts: publishedTranscripts, ...committedCounts };
}
