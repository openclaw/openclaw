import { isDeepStrictEqual } from "node:util";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunContext, getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-coordinator.js";
import {
  deferSqlitePostCommitPublication,
  stageSqliteTransactionState,
} from "../infra/sqlite-post-commit.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { restoreAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import type { OpenClawStateDatabaseReadAdmission } from "../state/openclaw-state-db-async-lifecycle.js";
import {
  openClawStateDatabaseCache,
  registerOpenClawStateDatabaseAsyncResource,
} from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { hasAuthoritativeTaskBacking } from "./task-backing-authority.js";
import {
  finishTaskMutation,
  retainTaskMutationFlowEffects,
} from "./task-executor-mutation-effects.async.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import { flushTaskActivity } from "./task-registry-activity.js";
import { recoverTaskAgentEventPublication } from "./task-registry-agent-event-commit.js";
import { publishTaskAgentEventDelivery } from "./task-registry-agent-event-delivery.js";
import {
  clearTaskAgentEventLineage,
  publishTaskAgentEventLineage,
} from "./task-registry-agent-event-lineage.js";
import {
  captureTaskAgentEventSource,
  sameTaskAgentEventSource,
} from "./task-registry-agent-event-source.js";
import type { TaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import {
  captureTaskAgentEventChange,
  captureTaskAgentEventLineage,
  readTaskAgentEventCommittedTarget,
  matchesTaskAgentEventTarget,
  prepareTaskAgentEventUpdate,
  TASK_ACTIVITY_LIVENESS_WRITE_MS,
  type TaskAgentEventReceipt,
} from "./task-registry-agent-event.operation.js";
import type { PendingTaskAgentEvent as PendingEvent } from "./task-registry-agent-events.types.js";
import { updateTaskWithPublication } from "./task-registry-mutation.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
  isEquivalentTaskRecord,
} from "./task-registry-records.js";
import {
  clearTaskActivity,
  runTaskRegistryWorkerMutation,
  invalidateTaskRegistryProjection,
  taskFlowSyncOwner,
  taskRegistryLog,
  tasks,
} from "./task-registry-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { getTaskRunOwner } from "./task-run-owner.js";

const pendingEvents = new Set<PendingEvent>();
const pendingByTask = new Map<string, Set<PendingEvent>>();
const drains = new Set<Promise<void>>();
let draining = false;
let active: PendingEvent | undefined;

registerOpenClawStateDatabaseAsyncResource({
  async close(identity) {
    if (
      !identity ||
      [...pendingEvents].some((pending) => pending.context.admission.identity.key === identity.key)
    ) {
      await Promise.allSettled(drains);
    }
    clearTaskAgentEventLineage(identity?.key);
  },
});

function assertCurrent(pending: PendingEvent, input = pending.input): void {
  const { source, context, store, flowStore } = pending;
  context.admission.assertCurrent();
  const runContext = getAgentRunContext(source.runId);
  if (
    getTaskRegistryStore() !== store ||
    getTaskFlowRegistryStore() !== flowStore ||
    getAgentRunLifecycleGeneration() !== source.lifecycleGeneration ||
    (runContext && runContext !== source.runContext)
  ) {
    throw new Error("Task event no longer belongs to its captured runtime owner");
  }
  if (
    input.backing?.runtime === "subagent" &&
    (subagentRuns.get(source.runId) !== source.subagent ||
      source.subagent?.generation !== source.subagentGeneration ||
      source.subagent?.childSessionKey !== input.expectedTask.childSessionKey)
  ) {
    throw new Error("Task event subagent backing was replaced");
  }
  const current = tasks.get(input.taskId);
  if (current && !matchesTaskAgentEventTarget(current, input)) {
    throw new Error("Task event selection was replaced");
  }
  if (input.change.kind === "terminal" && current && getTaskRunOwner(current)) {
    throw new Error("Task event cannot terminalize a producer-owned task");
  }
}

function removePendingTaskBatch(pending: PendingEvent): void {
  const entries = pendingByTask.get(pending.input.taskId);
  entries?.delete(pending);
  if (entries?.size === 0) {
    pendingByTask.delete(pending.input.taskId);
  }
}

function forget(pending: PendingEvent): void {
  publishTaskAgentEventLineage(pending);
  pendingEvents.delete(pending);
  removePendingTaskBatch(pending);
}

function settleNativeEvent(pending: PendingEvent, receipt: TaskAgentEventReceipt | null): void {
  const committed = () => {
    pending.receipt = receipt;
    publishTaskAgentEventLineage(pending);
    pending.native.resolve(receipt);
  };
  const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
    pending.context.admission.databasePath,
  );
  // A savepoint is not durable until its enclosing transaction and publications finish.
  if (
    database &&
    stageSqliteTransactionState(database.db, {
      stage() {},
      commit: committed,
      rollback: (error) => {
        invalidateTaskRegistryProjection();
        pending.native.reject(error);
      },
    })
  ) {
    return;
  }
  committed();
}

function advanceCommittedLineage(pending: PendingEvent, facts: unknown): void {
  const next = readTaskAgentEventCommittedTarget(facts, pending.input);
  // Later results must not advance successors accepted after a replacement.
  if (pending.committedTarget) {
    publishTaskAgentEventLineage(pending);
    return;
  }
  pending.committedTarget = next;
  for (const entry of pendingByTask.get(pending.input.taskId) ?? []) {
    if (
      entry !== pending &&
      entry !== active &&
      entry.store === pending.store &&
      entry.context.admission.identity.key === pending.context.admission.identity.key &&
      sameTaskAgentEventSource(entry.source, pending.source) &&
      isDeepStrictEqual(entry.input.expectedTask, pending.input.expectedTask) &&
      isDeepStrictEqual(entry.input.backing, pending.input.backing)
    ) {
      entry.input = { ...entry.input, expectedTask: next };
    }
  }
  publishTaskAgentEventLineage(pending);
}

function reportFailure(pending: PendingEvent, error: unknown): void {
  taskRegistryLog.warn(
    pending.receipt || pending.committedTarget
      ? "Task agent event committed before follow-up failed"
      : "Failed to persist accepted task agent event",
    {
      taskId: pending.input.taskId,
      runId: pending.source.runId,
      error,
    },
  );
}

function retainCommittedEventAfterResultFailure(pending: PendingEvent): void {
  const facts =
    pending.phase.kind === "granted" ? pending.phase.owner.settlement?.committed?.facts : undefined;
  if (!pending.receipt && facts !== undefined) {
    pending.commitFacts = facts;
    advanceCommittedLineage(pending, facts);
  }
}

function prepareNativeEventConsumption(): { consume: () => void; release: () => void } | undefined {
  const store = getTaskRegistryStore();
  const accepted = [...pendingEvents].filter((entry) => entry.store === store);
  const pending = accepted.filter((entry) => entry.phase.kind !== "consumed");
  // Native successors retain their FIFO position behind worker and deferred observers.
  const deferObservers = accepted.some(
    (entry) => entry.phase.kind === "granted" || entry.publishObserver !== undefined,
  );
  if (!pending.length) {
    return undefined;
  }
  const claimed = pending.filter(
    (entry) => entry.phase.kind !== "granted" && entry.phase.kind !== "native",
  );
  for (const entry of claimed) {
    entry.phase = { kind: "native" };
  }
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    for (const entry of claimed) {
      if (entry.phase.kind === "native") {
        entry.phase = { kind: entry === active ? "worker" : "waiting" };
      }
    }
  };
  try {
    if (pending.some((entry) => entry.phase.kind === "granted")) {
      // Join the granted transaction before a WAL read can select its predecessor.
      // Ungranted batches have already lost permission to perform the same write.
      store.settleAgentEventWrites((deadlineMs) => {
        for (const entry of pending) {
          if (entry.phase.kind !== "granted") {
            continue;
          }
          const completed = entry.phase.owner.waitForSettlement(deadlineMs);
          if (completed.committed) {
            entry.commitFacts = completed.committed.facts;
            advanceCommittedLineage(entry, completed.committed.facts);
          }
        }
      });
    }
  } catch (error) {
    release();
    throw error;
  }
  return {
    release,
    consume() {
      for (const entry of claimed) {
        try {
          assertCurrent(entry);
        } catch (error) {
          entry.phase = { kind: "consumed" };
          removePendingTaskBatch(entry);
          entry.native.reject(error);
          continue;
        }
        const current = tasks.get(entry.input.taskId);
        const receipt =
          current && hasAuthoritativeTaskBacking(current)
            ? prepareTaskAgentEventUpdate(current, entry.input)
            : null;
        let publishObserver: (() => void) | undefined;
        const publication = receipt
          ? updateTaskWithPublication(
              receipt.task.taskId,
              receipt.patch,
              deferObservers
                ? (publish) => {
                    publishObserver = publish;
                  }
                : undefined,
            )
          : null;
        if (receipt && !publication) {
          throw new Error("Failed to persist accepted task event before synchronous mutation");
        }
        if (receipt) {
          advanceCommittedLineage(entry, captureTaskAgentEventLineage(receipt));
        }
        entry.phase = { kind: "consumed" };
        // Leave settlement in the event owner, but consumed work no longer occupies its queue.
        removePendingTaskBatch(entry);
        settleNativeEvent(entry, receipt);
        if (receipt && publication) {
          const publish = () => {
            try {
              assertCurrent(entry, {
                ...entry.input,
                expectedTask: captureTaskPersistenceReceipt(receipt.task),
              });
            } catch {
              return;
            }
            // A later enclosing write can replace this row, including an ABA replacement.
            const latest = tasks.get(entry.input.taskId);
            if (latest && publication.isCurrent() && isEquivalentTaskRecord(latest, receipt.task)) {
              entry.delivery = { receipt, isCurrent: publication.isCurrent };
              publishObserver?.();
            }
          };
          const database = openClawStateDatabaseCache.getOpenClawStateDatabaseIfOpenAtPath(
            entry.context.admission.databasePath,
          );
          const afterCommit = deferObservers
            ? () => {
                entry.publishObserver = publish;
              }
            : publish;
          if (!database || !deferSqlitePostCommitPublication(database.db, afterCommit)) {
            afterCommit();
          }
        }
      }
    },
  };
}

export const taskAgentEventMutations = {
  prepare: prepareNativeEventConsumption,
  pendingTaskIds(): readonly string[] {
    const taskIds: string[] = [];
    for (const [taskId, entries] of pendingByTask) {
      for (const entry of entries) {
        if (entry.phase.kind !== "consumed") {
          taskIds.push(taskId);
          break;
        }
      }
    }
    return taskIds;
  },
  pending(taskId?: string) {
    const entries = taskId === undefined ? pendingEvents : pendingByTask.get(taskId);
    for (const entry of entries ?? []) {
      if (entry.phase.kind !== "consumed") {
        return true;
      }
    }
    return false;
  },
  async captureReadFence(admission: OpenClawStateDatabaseReadAdmission): Promise<void> {
    const store = getTaskRegistryStore();
    const accepted = [...pendingEvents].filter(
      (entry) =>
        entry.store === store && entry.context.admission.identity.key === admission.identity.key,
    );
    const settled = await Promise.allSettled(accepted.map((entry) => entry.completion.promise));
    const errors = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw createSqliteLifecycleAggregateError(
        errors,
        "Accepted task events failed to settle",
        errors[0],
      );
    }
  },
};

async function persist(pending: PendingEvent): Promise<void> {
  const { input, context, store, flowStore } = pending;
  const taskId = input.taskId;
  const scope = {
    taskId,
    runId: input.expectedTask.runId,
    childSessionKey: input.expectedTask.childSessionKey,
  };
  let flowEffectsSettled = false;
  let publicationFailure: { error: unknown } | undefined;
  try {
    try {
      await runTaskRegistryWorkerMutation(
        {
          scope,
          admission: context.admission,
          readIdentity: "preserved",
          prepare: async () => {
            const owner = taskFlowSyncOwner(taskId);
            // Native consumption owns settlement even when a held snapshot becomes stale.
            // Join that read, then let the mutation callback await native commit or rollback.
            while (pending.phase.kind !== "consumed") {
              if (await owner.prepare(context, store, 1)) {
                return;
              }
            }
          },
          onPublicationError: (error) => {
            publicationFailure = { error };
          },
          publicationRecords: () =>
            new Map(
              pending.publication && pending.phase.kind !== "consumed"
                ? [[taskId, pending.publication.task]]
                : [],
            ),
          recoverPublication: (snapshot) => {
            if (
              pending.commitFacts === undefined ||
              pending.receipt ||
              pending.phase.kind === "consumed"
            ) {
              return undefined;
            }
            pending.publication = recoverTaskAgentEventPublication(
              pending.commitFacts,
              input,
              snapshot.tasks.get(taskId),
            );
            return pending.publication?.task;
          },
          beforeObservers: async (assertCurrentPublication) => {
            if (pending.publication && pending.phase.kind !== "consumed") {
              const assertCurrentOwners = () => {
                assertCurrentPublication();
                if (getTaskRegistryStore() !== store || getTaskFlowRegistryStore() !== flowStore) {
                  throw new Error("Task event publication owners changed");
                }
              };
              assertCurrentOwners();
              const current = tasks.get(taskId);
              if (
                pending.publication.becomesTerminal &&
                current &&
                isEquivalentTaskRecord(current, pending.publication.task)
              ) {
                clearTaskActivity(taskId);
              }
              await finishTaskMutation(context, store, flowStore, taskId, {
                operation: "update",
                assertCurrent: assertCurrentOwners,
              });
              assertCurrentOwners();
              flowEffectsSettled = true;
            }
          },
          forcePublish: () => pending.publication?.task,
          onPublished: (task) => {
            if (
              pending.publication &&
              pending.phase.kind !== "consumed" &&
              isEquivalentTaskRecord(task, pending.publication.task)
            ) {
              pending.delivery = {
                receipt: pending.publication,
                isCurrent: () => tasks.get(taskId) === task,
              };
            }
          },
        },
        async (beginRecovery) => {
          if (pending.phase.kind === "consumed" || pending.phase.kind === "native") {
            return await pending.native.promise;
          }
          assertCurrent(pending);
          const current = tasks.get(taskId);
          if (!current || !matchesTaskAgentEventTarget(current, input)) {
            return null;
          }
          if (input.change.kind === "terminal") {
            flushTaskActivity(taskId);
          }
          pending.phase = { kind: "worker" };
          while (true) {
            try {
              pending.receipt = await store.runAgentEventMutationAsync(
                context,
                input,
                () => {
                  if (pending.phase.kind === "native" || pending.phase.kind === "consumed") {
                    throw pending.claimed;
                  }
                  assertCurrent(pending);
                },
                (owner) => {
                  beginRecovery();
                  pending.lineageResident = tasks.get(taskId);
                  pending.phase = { kind: "granted", owner };
                },
              );
              pending.publication = pending.receipt ?? undefined;
              if (pending.receipt) {
                advanceCommittedLineage(pending, captureTaskAgentEventLineage(pending.receipt));
              }
              if (pending.receipt?.cleanupError) {
                throw restoreAgentSchemaInspectionError(pending.receipt.cleanupError);
              }
              return pending.receipt;
            } catch (error) {
              if (error !== pending.claimed) {
                // The store joins native retirement before rejecting. Confirmed
                // commit facts survive even when the native outcome stays unknown.
                retainCommittedEventAfterResultFailure(pending);
                throw error;
              }
              if (pending.phase.kind !== "worker") {
                return await pending.native.promise;
              }
              // Only this exact refusal, followed by joined settlement, proves that
              // the failed native claimant left this batch unconsumed and unwritten.
            }
          }
        },
        () => store.loadMutationSnapshotAsync(context, scope),
      );
    } catch (error) {
      if (publicationFailure) {
        throw createSqliteLifecycleAggregateError(
          [error, publicationFailure.error],
          "Task event mutation and publication failed",
          error,
        );
      }
      throw error;
    }
    if (publicationFailure) {
      throw publicationFailure.error;
    }
  } finally {
    if (!flowEffectsSettled && pending.committedTarget && pending.phase.kind !== "consumed") {
      const current = tasks.get(taskId);
      if (
        current &&
        matchesTaskAgentEventTarget(current, { ...input, expectedTask: pending.committedTarget })
      ) {
        retainTaskMutationFlowEffects(context, store, flowStore, current, "update");
      }
    }
  }
}

function startDrain(): void {
  if (draining) {
    return;
  }
  draining = true;
  const operation = runWithGatewayDetachedWorkContinuation(async () => {
    try {
      while ((active = pendingEvents.values().next().value)) {
        const entry = active;
        try {
          await Promise.resolve();
          if (entry.phase.kind === "consumed") {
            await entry.native.promise;
          } else {
            await persist(entry);
          }
          try {
            entry.publishObserver?.();
          } finally {
            delete entry.publishObserver;
          }
          entry.completion.resolve();
        } catch (error) {
          entry.completion.reject(error);
          reportFailure(entry, error);
        } finally {
          forget(entry);
          active = undefined;
          // A committed notification starts after its own accepted event settles;
          // cleanup failure still rejects external readers without suppressing delivery.
          const delivery = entry.delivery;
          if (delivery) {
            publishTaskAgentEventDelivery(delivery, () =>
              assertCurrent(entry, {
                ...entry.input,
                expectedTask: captureTaskPersistenceReceipt(delivery.receipt.task),
              }),
            );
          }
        }
      }
    } finally {
      draining = false;
    }
  }, "tasks:agent-events").catch((error: unknown) => {
    draining = false;
    for (const entry of pendingEvents) {
      entry.completion.reject(error);
      reportFailure(entry, error);
      forget(entry);
    }
  });
  drains.add(operation);
  void operation.finally(() => drains.delete(operation));
}

/** At most one active batch and four ordered pending batches per live task identity. */
export function enqueueTaskAgentEvent(
  initialTask: TaskAgentEventTarget,
  event: AgentEventPayload,
): boolean {
  let task = initialTask;
  const source = captureTaskAgentEventSource(event);
  const entries = pendingByTask.get(task.taskId);
  const store = getTaskRegistryStore();
  const flowStore = getTaskFlowRegistryStore();
  const resident = tasks.get(task.taskId);
  const owned = [...(entries ?? [])].filter(
    (entry) =>
      entry.store === store &&
      entry.flowStore === flowStore &&
      sameTaskAgentEventSource(source, entry.source),
  );
  for (const entry of owned) {
    if (entry.phase.kind === "granted" && !entry.committedTarget) {
      const facts = entry.phase.owner.settlement?.committed?.facts;
      if (facts !== undefined) {
        entry.commitFacts = facts;
        advanceCommittedLineage(entry, facts);
      }
    }
  }
  const committed = owned.find(
    (entry) =>
      entry.phase.kind === "granted" &&
      resident !== undefined &&
      entry.lineageResident === resident &&
      entry.committedTarget &&
      entry.committedTarget.createdAt !== entry.input.expectedTask.createdAt &&
      matchesTaskPersistenceReceipt(task, entry.input.expectedTask) &&
      isDeepStrictEqual(task.backing, entry.input.backing),
  );
  if (committed?.committedTarget) {
    // Only this receipt's unchanged resident view may borrow its normalized timestamp.
    task = { ...task, createdAt: committed.committedTarget.createdAt };
  }
  const matches = (entry: PendingEvent) =>
    sameTaskAgentEventSource(source, entry.source) &&
    matchesTaskPersistenceReceipt(task, entry.committedTarget ?? entry.input.expectedTask) &&
    isDeepStrictEqual(task.backing, entry.input.backing);
  for (const entry of entries ?? []) {
    if (entry !== active && entry.phase.kind === "waiting" && !matches(entry)) {
      const error = new Error("Queued task event identity was replaced before admission");
      entry.completion.reject(error);
      entry.native.reject(error);
      reportFailure(entry, error);
      forget(entry);
    }
  }
  const matching = [...(pendingByTask.get(task.taskId) ?? [])].filter(matches);
  if (matching.some((entry) => entry.input.change.kind === "terminal")) {
    return false;
  }
  const lastAcceptedAt = matching.reduce(
    (at, entry) => Math.max(at, entry.input.change.at),
    task.lastEventAt ?? task.startedAt ?? task.createdAt,
  );
  const needsPersistence =
    event.stream === "lifecycle" ||
    event.stream === "error" ||
    (event.stream === "tool" && event.data.phase === "start") ||
    event.ts - lastAcceptedAt >= TASK_ACTIVITY_LIVENESS_WRITE_MS;
  if (!needsPersistence) {
    return true;
  }
  const backing = task.backing;
  const change = captureTaskAgentEventChange(
    task,
    event,
    !getTaskRunOwner(task) && !(task.runtime === "subagent" && backing?.runtime === "subagent"),
  );
  if (!change) {
    return true;
  }
  if (
    change.kind === "start" &&
    (task.status !== "queued" || matching.some((entry) => entry.input.change.kind === "start"))
  ) {
    change.kind = "progress";
  }
  const previous = matching.at(-1);
  if (
    change.kind === "progress" &&
    previous?.phase.kind === "waiting" &&
    previous !== active &&
    previous.input.change.kind === "progress"
  ) {
    previous.input.change = {
      ...change,
      toolStarts: previous.input.change.toolStarts + change.toolStarts,
      refreshError: previous.input.change.refreshError || change.refreshError,
      patch: { ...previous.input.change.patch, ...change.patch },
    };
    return true;
  }
  const context = captureOpenClawStateWorkerContext();
  const entry: PendingEvent = {
    input: {
      taskId: task.taskId,
      expectedTask: captureTaskPersistenceReceipt(task),
      backing,
      change,
    },
    source,
    context,
    store,
    flowStore,
    phase: { kind: "waiting" },
    native: createDeferredCore(),
    completion: createDeferredCore(),
    claimed: new Error("Task event was claimed by synchronous registry mutation"),
  };
  void entry.native.promise.catch(() => undefined);
  void entry.completion.promise.catch(() => undefined);
  pendingEvents.add(entry);
  const taskEvents = pendingByTask.get(task.taskId) ?? new Set<PendingEvent>();
  taskEvents.add(entry);
  pendingByTask.set(task.taskId, taskEvents);
  startDrain();
  return true;
}
