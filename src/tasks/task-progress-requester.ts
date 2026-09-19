import { createHash } from "node:crypto";
import type { AcceptedSessionSpawn } from "../agents/accepted-session-spawn.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type {
  ProgressContinuationCapability,
  ProgressContinuationState,
} from "../channels/progress-continuation.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import {
  prepareTaskBackingRead,
  readTaskBackingInstance,
  type TaskBackingRead,
} from "./task-backing-authority.js";
import { resolveTaskDeliveryOwner } from "./task-registry-delivery.js";
import {
  MAX_PROGRESS_BATCH_MEMBERS,
  scheduleYieldedSubagentRunProgress,
  flushTaskProgressBatch,
  getTaskProgressBatchesForRuns,
  recordRequesterTaskProgress,
} from "./task-registry-progress.js";
import { sameTaskRunScope } from "./task-registry-records.js";
import { taskProgressBatches, taskRegistryLog } from "./task-registry-state.js";
import type { TaskProgressBatch } from "./task-registry.process-state.js";

type RequesterContinuation = NonNullable<TaskProgressBatch["requesterContinuation"]>;

function isCurrentContinuation(
  key: string,
  batch: TaskProgressBatch,
  continuation: RequesterContinuation,
): boolean {
  return (
    taskProgressBatches.get(key) === batch &&
    batch.requesterContinuation === continuation &&
    batch.requesterSessionId === continuation.requesterSessionId &&
    batch.lifecycleGeneration === getAgentRunLifecycleGeneration() &&
    !batch.abortController.signal.aborted &&
    continuation.isCurrent()
  );
}

function logProgressFailure(error: unknown): void {
  taskRegistryLog.debug(
    "Requester progress update could not finish; task completion is unaffected",
    {
      error: formatErrorMessage(error),
    },
  );
}

/** Observe the admitted requester turn without changing its delivery outcome. */
export async function withTaskProgressRequesterContinuation<T>(
  params: {
    entries: readonly SubagentRunRecord[];
    runId: string;
    requesterSessionId: string;
    isCurrent: () => boolean;
  },
  run: () => Promise<T>,
): Promise<T> {
  let batches: Array<{ key: string; batch: TaskProgressBatch }>;
  try {
    batches = await getTaskProgressBatchesForRuns(params.entries);
  } catch (error) {
    logProgressFailure(error);
    return await run();
  }
  if (batches.length === 0) {
    return await run();
  }
  const bindings: Array<{
    key: string;
    batch: TaskProgressBatch;
    continuation: RequesterContinuation;
  }> = [];
  let unsubscribe: (() => void) | undefined;
  try {
    const [{ normalizeAgentPlanSteps }, { readPreparedTaskActivityItem }] = await Promise.all([
      import("../channels/streaming.js"),
      import("./task-registry-activity.js"),
    ]);
    for (const { key, batch } of batches) {
      if (
        taskProgressBatches.get(key) !== batch ||
        batch.requesterSessionId !== params.requesterSessionId ||
        batch.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
        batch.abortController.signal.aborted ||
        !params.isCurrent()
      ) {
        continue;
      }
      const continuation: RequesterContinuation = {
        runId: params.runId,
        requesterSessionId: params.requesterSessionId,
        isCurrent: params.isCurrent,
      };
      batch.requesterContinuation = continuation;
      bindings.push({ key, batch, continuation });
    }
    if (bindings.length > 0) {
      unsubscribe = onAgentEvent((event) => {
        if (event.runId !== params.runId || (event.stream !== "item" && event.stream !== "plan")) {
          return;
        }
        try {
          const item = event.stream === "item" ? readPreparedTaskActivityItem(event) : undefined;
          const plan =
            event.stream === "plan" && event.data.phase === "update"
              ? {
                  steps: normalizeAgentPlanSteps(event.data.steps),
                  explanation:
                    typeof event.data.explanation === "string" ? event.data.explanation : undefined,
                  ...(event.data.explanationFormat === "plain"
                    ? { explanationFormat: "plain" as const }
                    : {}),
                }
              : undefined;
          if (!item && !plan) {
            return;
          }
          for (const { key, batch, continuation } of bindings) {
            if (!isCurrentContinuation(key, batch, continuation)) {
              continue;
            }
            if (item) {
              recordRequesterTaskProgress(key, batch, { kind: "item", item });
            } else if (plan) {
              recordRequesterTaskProgress(key, batch, { kind: "plan", plan });
            }
          }
        } catch (error) {
          logProgressFailure(error);
        }
      });
    }
  } catch (error) {
    logProgressFailure(error);
  }
  try {
    return await run();
  } finally {
    unsubscribe?.();
    await Promise.all(
      bindings.map(async ({ key, batch, continuation }) => {
        if (batch.requesterContinuation !== continuation) {
          return;
        }
        try {
          await flushTaskProgressBatch(key, batch);
        } catch (error) {
          logProgressFailure(error);
        } finally {
          if (batch.requesterContinuation === continuation) {
            batch.requesterContinuation = undefined;
          }
        }
      }),
    );
  }
}

/** A further yield inherits only the receipt attached to this exact resumed turn. */
export function captureTaskProgressContinuationForRequesterTurn(params: {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
}): ProgressContinuationState | undefined {
  const requesterSessionKey = params.requesterSessionKey.trim();
  const requesterTurnRunId = params.requesterTurnRunId.trim();
  if (!requesterSessionKey || !requesterTurnRunId) {
    return undefined;
  }
  try {
    for (const [key, batch] of taskProgressBatches) {
      const continuation = batch.requesterContinuation;
      if (
        batch.operationId &&
        batch.requesterSessionKey === requesterSessionKey &&
        (params.requesterAgentId === undefined ||
          batch.requesterAgentId === params.requesterAgentId) &&
        continuation?.runId === requesterTurnRunId &&
        isCurrentContinuation(key, batch, continuation)
      ) {
        return { operationId: batch.operationId };
      }
    }
  } catch (error) {
    logProgressFailure(error);
  }
  return undefined;
}
type TaskProgressContinuationParams = {
  requesterSessionKey: string;
  requesterAgentId?: string;
  requesterTurnRunId: string;
  acceptedSessionSpawns: readonly AcceptedSessionSpawn[];
  onAdopted?: (state: ProgressContinuationState) => void;
};

/** A turn-scoped capability transfers only a positively identified existing card. */
export async function createTaskProgressContinuation(
  params: TaskProgressContinuationParams,
): Promise<ProgressContinuationCapability | undefined> {
  try {
    const read = await prepareTaskBackingRead();
    return read ? createPreparedTaskProgressContinuation(params, read) : undefined;
  } catch (error) {
    logProgressFailure(error);
    return undefined;
  }
}

function createPreparedTaskProgressContinuation(
  params: TaskProgressContinuationParams,
  read: TaskBackingRead,
): ProgressContinuationCapability | undefined {
  const accepted = params.acceptedSessionSpawns.map((spawn) => ({
    spawn,
    entry: getLatestLiveSubagentRunByChildSessionKey(spawn.childSessionKey),
  }));
  if (
    accepted.some(({ spawn, entry }) => !entry || (entry.taskRunId ?? entry.runId) !== spawn.runId)
  ) {
    return undefined;
  }
  const rows = accepted.flatMap(({ spawn, entry }) => {
    const task =
      entry &&
      !entry.collect &&
      !entry.suppressAnnounceReason &&
      !entry.execution.suppressSessionEffects
        ? read
            .getTasksByRunId(entry.taskRunId ?? entry.runId)
            .find(
              (candidate) =>
                candidate.runtime === "subagent" &&
                candidate.childSessionKey === spawn.childSessionKey &&
                candidate.ownerKey === params.requesterSessionKey &&
                candidate.notifyPolicy !== "silent" &&
                readTaskBackingInstance(candidate.detail)?.generation === entry.generation &&
                read.hasAuthoritativeTaskBacking(candidate),
            )
        : undefined;
    return entry && task && entry.generation !== undefined
      ? [
          {
            entry,
            task,
            generation: entry.generation,
            wakeGeneration: entry.requesterSettleWake?.rearmGeneration,
          },
        ]
      : [];
  });
  const first = rows[0];
  const owner = first ? resolveTaskDeliveryOwner(first.task, read.getTaskFlowById) : undefined;
  const requesterSessionId = first?.entry.completionRequesterSessionId;
  if (
    !first ||
    !owner?.agentId ||
    !owner.requesterOrigin ||
    !requesterSessionId ||
    rows.length > MAX_PROGRESS_BATCH_MEMBERS
  ) {
    return undefined;
  }
  const agentId = owner.agentId;
  const origin = { ...owner.requesterOrigin };
  const audience = JSON.stringify([owner.agentId, owner.sessionKey, origin]);
  const lifecycleGeneration = getAgentRunLifecycleGeneration();
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, getGatewayRestartDrainSignal()]);
  let used = false;
  const assertCurrent = () => {
    signal.throwIfAborted();
    read.assertCurrent();
    if (getAgentRunLifecycleGeneration() !== lifecycleGeneration) {
      throw new Error("Progress handoff lifecycle was replaced");
    }
    for (const row of rows) {
      const entry = subagentRuns.get(row.entry.runId);
      const task = read.getTaskById(row.task.taskId);
      const currentOwner = task ? resolveTaskDeliveryOwner(task, read.getTaskFlowById) : undefined;
      if (
        entry !== row.entry ||
        entry.generation !== row.generation ||
        entry.requesterSessionKey !== params.requesterSessionKey ||
        entry.completionRequesterSessionId !== requesterSessionId ||
        entry.killIntent ||
        entry.killReconciliation ||
        entry.execution.suppressSessionEffects ||
        entry.suppressAnnounceReason ||
        entry.collect ||
        !task ||
        !sameTaskRunScope(task, row.task) ||
        readTaskBackingInstance(task.detail)?.generation !== row.generation ||
        task.notifyPolicy === "silent" ||
        !read.hasAuthoritativeTaskBacking(task) ||
        JSON.stringify([
          currentOwner?.agentId,
          currentOwner?.sessionKey,
          currentOwner?.requesterOrigin,
        ]) !== audience ||
        (params.requesterAgentId && currentOwner?.agentId !== params.requesterAgentId) ||
        (params.onAdopted
          ? entry.requesterTurnRunId !== params.requesterTurnRunId ||
            entry.requesterTurnYielded !== true
          : entry.requesterSettleWake?.requesterYieldBatch !== true ||
            entry.requesterSettleWake.status !== "pending" ||
            entry.requesterSettleWake.rearmGeneration !== row.wakeGeneration)
      ) {
        throw new Error("Progress handoff owner was replaced");
      }
    }
  };
  try {
    assertCurrent();
  } catch {
    return undefined;
  }
  return {
    adopt: async (receipt) => {
      if (used || signal.aborted) {
        return false;
      }
      used = true;
      try {
        // Transport and SQLite stay lazy until a channel offers an actual receipt.
        const { adoptTaskProgressMessage } = await import("./task-registry-progress-runtime.js");
        assertCurrent();
        const operationId = `task-progress:${createHash("sha256")
          .update(
            JSON.stringify([requesterSessionId, params.requesterTurnRunId, receipt.messageId]),
          )
          .digest("hex")}`;
        const adopted = await adoptTaskProgressMessage({
          operationId,
          requesterSessionId,
          sessionKey: params.requesterSessionKey,
          agentId,
          origin,
          receipt: structuredClone(receipt),
          signal,
          assertCurrent,
        });
        if (!adopted) {
          return false;
        }
        assertCurrent();
        if (params.onAdopted) {
          params.onAdopted({ operationId });
        } else {
          // Registry bootstrap imports this presenter through its lifecycle owner.
          const { attachRequesterProgressPresentation } =
            await import("../agents/subagents/registry/subagent-registry.js");
          assertCurrent();
          const members = rows.map((row) => {
            if (row.wakeGeneration === undefined) {
              throw new Error("Progress handoff has no yielded batch");
            }
            return {
              runId: row.entry.runId,
              generation: row.generation,
              rearmGeneration: row.wakeGeneration,
            };
          });
          attachRequesterProgressPresentation({ operationId, members, assertCurrent });
          for (const row of rows) {
            scheduleYieldedSubagentRunProgress(row.entry);
          }
        }
        return true;
      } catch (error) {
        taskRegistryLog.debug("Existing progress card could not transfer", {
          error: formatErrorMessage(error),
        });
        return false;
      }
    },
    close: () => {
      controller.abort();
    },
  };
}
