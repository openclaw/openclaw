import { isDeepStrictEqual } from "node:util";
import { createDeferredCore } from "../shared/deferred.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import type { TaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import {
  cloneTaskDeliveryState,
  cloneTaskRecord,
  cloneTaskRecordForObserver,
  isEquivalentTaskRecord,
} from "./task-registry-records.js";
import {
  getTaskRegistryProcessState,
  matchesScope,
  recordTaskRegistryReadCompletion,
  selectTaskRegistryScopes,
  taskIdsInScope,
  type PendingTaskRegistryMutation,
  type TaskRegistryReadWitness,
} from "./task-registry.process-state.js";
import type { TaskRegistryStore } from "./task-registry.store.js";
import type {
  TaskRegistryMutationScope,
  TaskRegistryStoreSnapshot,
  TaskRegistryObserverEvent,
} from "./task-registry.store.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRegistryWorkerMutationContext = {
  scope: TaskRegistryMutationScope;
  admission: OpenClawStateDatabaseReadAdmission;
  publicationRecords: () => ReadonlyMap<string, TaskRecord>;
  readEventTarget?: () => TaskAgentEventTarget | undefined;
  /** Only a producer whose write contract preserves task routing, access, and detail. */
  readIdentity?: "preserved";
  /** Prepare current rows before this mutation invalidates their projection. */
  prepare?: () => Promise<void>;
  taskRowsWritten?: () => boolean;
  beforeObservers?: (assertCurrent: () => void) => Promise<void>;
  recoverPublication?: (snapshot: TaskRegistryStoreSnapshot) => TaskRecord | undefined;
  onPublished?: (task: TaskRecord) => void;
  onPublicationError?: (error: unknown) => void;
  forcePublish?: () => TaskRecord | undefined;
};

function* currentTasksInScopes(scopes: readonly TaskRegistryMutationScope[]): Iterable<TaskRecord> {
  const { tasks } = getTaskRegistryProcessState();
  const { taskIds, matches } = selectTaskRegistryScopes(scopes);
  for (const taskId of taskIds) {
    const task = tasks.get(taskId);
    if (task && matches(task)) {
      yield task;
    }
  }
}

function captureTaskRegistryWorkerSnapshot(
  scopes: readonly TaskRegistryMutationScope[],
): TaskRegistryStoreSnapshot {
  const state = getTaskRegistryProcessState();
  const captured: TaskRegistryStoreSnapshot = { tasks: new Map(), deliveryStates: new Map() };
  for (const task of currentTasksInScopes(scopes)) {
    const taskId = task.taskId;
    const delivery = state.taskDeliveryStates.get(taskId);
    captured.tasks.set(taskId, cloneTaskRecord(task));
    if (delivery) {
      captured.deliveryStates.set(taskId, cloneTaskDeliveryState(delivery));
    }
  }
  return captured;
}

function createTaskRegistryPublicationRecovery(
  pending: PendingTaskRegistryMutation,
  recover: (snapshot: TaskRegistryStoreSnapshot) => TaskRecord | undefined,
) {
  const witness = { writtenTaskIds: new Set<string>(), replaced: false };
  pending.recoveryWitness = witness;
  let expected: TaskRecord | undefined;
  const superseded = new Error("Task publication was superseded by a current write");
  return {
    isSuperseded: (error: unknown) => error === superseded,
    begin() {
      witness.writtenTaskIds.clear();
      witness.replaced = false;
    },
    recover: (snapshot: TaskRegistryStoreSnapshot) => {
      expected = recover(snapshot);
      return expected;
    },
    assertCurrent() {
      if (!expected) {
        return;
      }
      const current = getTaskRegistryProcessState().tasks.get(expected.taskId);
      if (
        witness.replaced ||
        witness.writtenTaskIds.has(expected.taskId) ||
        !current ||
        !isEquivalentTaskRecord(current, expected)
      ) {
        throw superseded;
      }
    },
  };
}

type TaskRegistrySnapshotReconciliation = {
  snapshot: TaskRegistryStoreSnapshot;
  conflicted: boolean;
  divergentScopes: ReadonlySet<TaskRegistryMutationScope>;
};

/** Preserve committed projection writes, including ABA, without restarting the settled mutation. */
function mergeTaskRegistryWorkerSnapshot(params: {
  scopes: readonly TaskRegistryMutationScope[];
  captured: TaskRegistryStoreSnapshot;
  snapshot: TaskRegistryStoreSnapshot;
  witness: NonNullable<PendingTaskRegistryMutation["readWitness"]>;
  pending?: PendingTaskRegistryMutation;
}): TaskRegistrySnapshotReconciliation {
  const { scopes, captured, snapshot, witness } = params;
  const state = getTaskRegistryProcessState();
  const { matches } = selectTaskRegistryScopes(scopes);
  const completedMatches = selectTaskRegistryScopes([...witness.completedScopes]).matches;
  const divergentScopes = new Set<TaskRegistryMutationScope>();
  const markDivergentScopes = (
    taskId: string,
    current: TaskRecord | undefined,
    committed?: TaskRecord,
  ) => {
    for (const scope of scopes) {
      if (
        scope.taskId === taskId ||
        [captured.tasks.get(taskId), snapshot.tasks.get(taskId), current, committed].some(
          (task) => task && matchesScope(task, scope),
        )
      ) {
        divergentScopes.add(scope);
      }
    }
  };
  const retainCanonicalRead = (taskId: string, current: TaskRecord | undefined) => {
    const stored = snapshot.tasks.get(taskId);
    const sameTask =
      current && stored ? isEquivalentTaskRecord(current, stored) : current === stored;
    if (
      sameTask &&
      isDeepStrictEqual(snapshot.deliveryStates.get(taskId), state.taskDeliveryStates.get(taskId))
    ) {
      return;
    }
    markDivergentScopes(taskId, current);
  };
  const unpublishedConflicts = new Set<string>();
  for (const other of state.projection.pending) {
    const publication = other.publication;
    if (other === params.pending || !publication) {
      continue;
    }
    const recovery = other.recoveryWitness;
    const targetId = other.scope.taskId;
    if (
      other.readWitness &&
      recovery &&
      !recovery.replaced &&
      !recovery.writtenTaskIds.has(targetId) &&
      !publication.records.has(targetId)
    ) {
      // A lost result must be recovered by its own read before peers certify this scope.
      for (const scope of scopes) {
        if (
          scope.taskId === targetId ||
          (scope.runId && scope.runId === other.scope.runId) ||
          (scope.childSessionKey && scope.childSessionKey === other.scope.childSessionKey) ||
          [
            captured.tasks.get(targetId),
            snapshot.tasks.get(targetId),
            state.tasks.get(targetId),
          ].some((task) => task && matchesScope(task, scope))
        ) {
          unpublishedConflicts.add(targetId);
          divergentScopes.add(scope);
        }
      }
    }
    for (const [taskId, committed] of publication.records) {
      const stored = snapshot.tasks.get(taskId);
      const current = state.tasks.get(taskId);
      if (
        !publication.invalidated.has(taskId) &&
        !publication.ready.has(taskId) &&
        [captured.tasks.get(taskId), stored, current, committed].some(
          (task) => task && matches(task),
        ) &&
        (!stored || !isEquivalentTaskRecord(stored, committed))
      ) {
        // An unread committed receipt owns publication; this snapshot cannot certify its scope.
        unpublishedConflicts.add(taskId);
        markDivergentScopes(taskId, current, committed);
      }
    }
  }
  const merged = {
    tasks: new Map(snapshot.tasks),
    deliveryStates: new Map(snapshot.deliveryStates),
  };
  let conflicted = unpublishedConflicts.size > 0;
  for (const taskId of new Set([
    ...captured.tasks.keys(),
    ...snapshot.tasks.keys(),
    ...unpublishedConflicts,
    ...Array.from(currentTasksInScopes(scopes), (task) => task.taskId),
  ])) {
    const current = state.tasks.get(taskId);
    if (current && !matches(current)) {
      const stored = snapshot.tasks.get(taskId);
      const changed = captured.tasks.has(taskId) || Boolean(stored && matches(stored));
      conflicted ||= changed;
      if (changed) {
        retainCanonicalRead(taskId, current);
      }
      merged.tasks.delete(taskId);
      merged.deliveryStates.delete(taskId);
      continue;
    }
    const delivery = state.taskDeliveryStates.get(taskId);
    if (
      !witness.replaced &&
      !witness.writtenTaskIds.has(taskId) &&
      !unpublishedConflicts.has(taskId) &&
      ![captured.tasks.get(taskId), snapshot.tasks.get(taskId), current].some(
        (task) => task && completedMatches(task),
      ) &&
      isDeepStrictEqual(captured.tasks.get(taskId), current) &&
      isDeepStrictEqual(captured.deliveryStates.get(taskId), delivery)
    ) {
      continue;
    }
    conflicted = true;
    retainCanonicalRead(taskId, current);
    if (current) {
      merged.tasks.set(taskId, current);
    } else {
      merged.tasks.delete(taskId);
    }
    if (delivery) {
      merged.deliveryStates.set(taskId, delivery);
    } else {
      merged.deliveryStates.delete(taskId);
    }
  }
  return { snapshot: merged, conflicted, divergentScopes };
}

/** Refresh and publication preserve newer committed rows through the same read witnesses. */
export async function reconcileTaskRegistrySnapshot<T>(params: {
  scopes: readonly TaskRegistryMutationScope[];
  pending?: PendingTaskRegistryMutation;
  assertCurrent: () => void;
  read: () => Promise<TaskRegistryStoreSnapshot>;
  consume: (result: TaskRegistrySnapshotReconciliation) => T;
}): Promise<T> {
  const { scopes, pending, assertCurrent, read } = params;
  const projection = getTaskRegistryProcessState().projection;
  let witness: TaskRegistryReadWitness | undefined;
  try {
    assertCurrent();
    const captured = captureTaskRegistryWorkerSnapshot(scopes);
    witness = {
      scopes,
      taskIds: new Set([...captured.tasks.keys(), ...(pending?.published.keys() ?? [])]),
      writtenTaskIds: new Set<string>(),
      completedScopes: new Set<TaskRegistryMutationScope>(),
      replaced: false,
    };
    projection.readWitnesses.add(witness);
    if (pending) {
      pending.readWitness = witness;
    }
    const snapshot = await read();
    projection.readWitnesses.delete(witness);
    if (pending) {
      delete pending.readWitness;
    }
    assertCurrent();
    const merged = mergeTaskRegistryWorkerSnapshot({
      scopes,
      captured,
      snapshot,
      witness,
      pending,
    });
    return params.consume(merged);
  } finally {
    if (witness) {
      projection.readWitnesses.delete(witness);
    }
    if (pending) {
      delete pending.readWitness;
    }
  }
}

/** Release read custody before effects or observers can await descendants. */
export async function reconcileTaskRegistryWorkerSnapshot(params: {
  pending: PendingTaskRegistryMutation;
  assertCurrent: () => void;
  read: () => Promise<TaskRegistryStoreSnapshot>;
  install: (snapshot: TaskRegistryStoreSnapshot, records?: ReadonlyMap<string, TaskRecord>) => void;
  recoverPublication?: (snapshot: TaskRegistryStoreSnapshot) => TaskRecord | undefined;
  taskRowsWritten?: boolean;
}): Promise<{ conflicted: boolean }> {
  const { pending, install } = params;
  const projection = getTaskRegistryProcessState().projection;
  const predecessor = projection.readTail;
  const phase = createDeferredCore();
  projection.readTail = phase.promise;
  try {
    await predecessor;
    return await reconcileTaskRegistrySnapshot({
      scopes: [pending.scope],
      pending,
      assertCurrent: params.assertCurrent,
      read: params.read,
      consume(merged) {
        const recovery = pending.recoveryWitness;
        if (
          params.recoverPublication &&
          recovery &&
          !recovery.replaced &&
          !recovery.writtenTaskIds.has(pending.scope.taskId)
        ) {
          const recovered = params.recoverPublication(merged.snapshot);
          if (recovered) {
            if (recovered.taskId !== pending.scope.taskId) {
              throw new Error("Recovered publication differs from its committed task target");
            }
            claimTaskRegistryPublication(pending, new Map([[recovered.taskId, recovered]]));
          }
        }
        // This owner's synchronous install is not a competing write. Keep tracking
        // replacements across the awaited flow effects that follow it.
        delete pending.recoveryWitness;
        try {
          install(
            merged.snapshot,
            params.taskRowsWritten === false ? undefined : pending.publication?.records,
          );
          if (!merged.divergentScopes.has(pending.scope)) {
            recordTaskRegistryReadCompletion([pending.scope]);
          }
        } finally {
          pending.recoveryWitness = recovery;
        }
        const { tasks } = getTaskRegistryProcessState();
        for (const [taskId, expected] of pending.publication?.records ?? []) {
          const current = tasks.get(taskId);
          if (current !== undefined && isEquivalentTaskRecord(expected, current)) {
            pending.publication?.ready.add(taskId);
          }
        }
        return { conflicted: merged.conflicted };
      },
    });
  } finally {
    if (projection.readTail === phase.promise) {
      delete projection.readTail;
    }
    phase.resolve();
  }
}

/** Keep the original baseline registered while observers may synchronously publish other rows. */
export function publishTaskRegistryWorkerMutation(params: {
  pending: PendingTaskRegistryMutation;
  forced?: TaskRecord;
  emit: (event: () => TaskRegistryObserverEvent) => void;
  onPublished?: (task: TaskRecord) => void;
}): void {
  const { pending, forced, emit } = params;
  const publication = pending.publication;
  if (!publication) {
    return;
  }
  const { tasks } = getTaskRegistryProcessState();
  for (const [taskId, expected] of publication.records) {
    if (!publication.ready.has(taskId) || publication.invalidated.has(taskId)) {
      continue;
    }
    const next = tasks.get(taskId);
    if (next === undefined || !isEquivalentTaskRecord(expected, next)) {
      continue;
    }
    const previous = pending.published.get(taskId);
    if (
      !isDeepStrictEqual(previous, cloneTaskRecordForObserver(next)) ||
      (forced?.taskId === taskId && isEquivalentTaskRecord(forced, next))
    ) {
      emit(() => ({
        kind: "upserted",
        task: cloneTaskRecordForObserver(next),
        ...(previous ? { previous } : {}),
      }));
      const current = tasks.get(taskId);
      if (
        current &&
        !publication.invalidated.has(taskId) &&
        isEquivalentTaskRecord(expected, current)
      ) {
        params.onPublished?.(current);
      }
    }
  }
}

function inheritPublicationBaseline(pending: PendingTaskRegistryMutation, taskId: string): void {
  const state = getTaskRegistryProcessState();
  for (const prior of state.projection.pending) {
    if (
      prior !== pending &&
      (prior.published.has(taskId) || prior.publication?.records.has(taskId))
    ) {
      const previous = prior.published.get(taskId);
      pending.published.set(taskId, previous && cloneTaskRecordForObserver(previous));
      return;
    }
  }
  const current = state.tasks.get(taskId);
  pending.published.set(taskId, current && cloneTaskRecordForObserver(current));
}

/** Receipt rows own publication; broad snapshot selection grants no readiness for sibling rows. */
export function claimTaskRegistryPublication(
  pending: PendingTaskRegistryMutation,
  records: ReadonlyMap<string, TaskRecord>,
): void {
  for (const taskId of records.keys()) {
    if (!pending.published.has(taskId)) {
      inheritPublicationBaseline(pending, taskId);
    }
  }
  pending.publication = {
    records: new Map(Array.from(records, ([taskId, record]) => [taskId, cloneTaskRecord(record)])),
    ready: new Set(),
    invalidated: new Set(),
  };
  const recovery = pending.recoveryWitness;
  for (const [taskId, record] of pending.publication.records) {
    // Competing writes can precede the receipt's publication claim.
    if (recovery?.replaced || recovery?.writtenTaskIds.has(taskId)) {
      pending.publication.invalidated.add(taskId);
    }
    const previous = pending.published.get(taskId);
    for (const other of getTaskRegistryProcessState().projection.pending) {
      if (
        other !== pending &&
        !other.published.has(taskId) &&
        (other.scope.taskId === taskId ||
          matchesScope(record, other.scope) ||
          (previous && matchesScope(previous, other.scope)))
      ) {
        other.published.set(taskId, previous && cloneTaskRecordForObserver(previous));
      }
    }
  }
}

export function createPendingTaskRegistryMutation(
  {
    scope,
    admission,
    readIdentity,
    recoverPublication,
  }: Pick<
    TaskRegistryWorkerMutationContext,
    "scope" | "admission" | "readIdentity" | "recoverPublication"
  >,
  store: TaskRegistryStore,
  readEventTarget?: () => TaskAgentEventTarget | undefined,
) {
  const readSettlement = readIdentity === "preserved" ? undefined : createDeferredCore();
  const pending: PendingTaskRegistryMutation = {
    scope,
    readIdentity,
    ...(readSettlement && {
      readSettlement: {
        databaseKey: admission.identity.key,
        store,
        promise: readSettlement.promise,
      },
    }),
    published: new Map(
      Array.from(currentTasksInScopes([scope]), (task) => [
        task.taskId,
        cloneTaskRecordForObserver(task),
      ]),
    ),
  };
  const baselineIds = new Set([...pending.published.keys(), scope.taskId]);
  for (const prior of getTaskRegistryProcessState().projection.pending) {
    for (const [taskId, published] of prior.published) {
      if (published && matchesScope(published, scope)) {
        baselineIds.add(taskId);
      }
    }
    for (const [taskId, record] of prior.publication?.records ?? []) {
      if (matchesScope(record, scope)) {
        baselineIds.add(taskId);
      }
    }
  }
  for (const taskId of baselineIds) {
    inheritPublicationBaseline(pending, taskId);
  }
  if (readEventTarget) {
    const { tasks } = getTaskRegistryProcessState();
    const residentTargets = new Map(
      [...taskIdsInScope(scope)].map((taskId) => [taskId, tasks.get(taskId)]),
    );
    pending.readEventTarget = () => {
      const target = readEventTarget();
      // A committed creation may fill an unchanged projection, never replace a newer one.
      return target && tasks.get(target.taskId) === residentTargets.get(target.taskId)
        ? target
        : undefined;
    };
  }
  const recovery = recoverPublication
    ? createTaskRegistryPublicationRecovery(pending, recoverPublication)
    : undefined;
  return { pending, recovery, settle: readSettlement?.resolve };
}
