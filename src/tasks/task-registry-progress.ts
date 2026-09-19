import { createHash } from "node:crypto";
import type { AgentActivityItem } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  getLatestSubagentRunByChildSessionKey,
  isSubagentRunLive,
} from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { getChannelPlugin } from "../channels/plugins/index.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayDetachedWorkContinuation,
} from "../process/gateway-work-admission.js";
import type { SessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { hasResidentTaskBacking, prepareTaskBackingRead } from "./task-backing-authority.js";
import { readResidentTaskFlow } from "./task-flow-runtime-internal.js";
import {
  prepareProgressBatch,
  resolveYieldedTaskProgress,
  type ProgressRead,
} from "./task-progress-batch.js";
import { loadTaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";
import {
  getTasksByRunId,
  tasks,
  taskProgressBatches,
  taskRegistryLog,
} from "./task-registry-state.js";
import type { TaskProgressBatch, TaskProgressPlan } from "./task-registry.process-state.js";
import type { TaskRegistryObserverEvent } from "./task-registry.store.types.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { formatTaskStatusTitleText } from "./task-status.js";

const YIELDED_PROGRESS_COALESCE_MS = 15_000;
const MAX_PROGRESS_BATCHES = 128;
export const MAX_PROGRESS_BATCH_MEMBERS = 32;
const MAX_PENDING_PROGRESS_ITEMS = 128;
const loadProgressPresentation = createLazyPromise(() => import("./task-progress-presentation.js"));
const loadProgressRuntime = createLazyPromise(() => import("./task-registry-progress-runtime.js"));
const residentProgressRead: ProgressRead = {
  getTaskById: (taskId) => tasks.get(taskId),
  getTaskFlowById: readResidentTaskFlow,
  hasAuthoritativeTaskBacking: hasResidentTaskBacking,
};

/** Detached presentation consumes prepared public activity, never raw child prose or results. */
export function scheduleYieldedSubagentTaskProgress(
  task: TaskRecord,
  event: AgentEventPayload,
  prepared?: AgentActivityItem,
) {
  if (
    event.stream !== "item" &&
    event.stream !== "tool" &&
    event.stream !== "approval" &&
    event.stream !== "execution"
  ) {
    return;
  }
  enqueueYieldedTaskProgress(task, event.runId, prepared);
}

/** The handoff itself may be the last event before a child's long-running tool returns. */
export function scheduleYieldedSubagentRunProgress(entry: SubagentRunRecord) {
  for (const task of getTasksByRunId(entry.taskRunId ?? entry.runId)) {
    enqueueYieldedTaskProgress(task, entry.runId);
  }
}

function enqueueYieldedTaskProgress(task: TaskRecord, runId: string, prepared?: AgentActivityItem) {
  // Capture records without draining persistence; adoption and delivery recheck authority.
  const progress = resolveYieldedTaskProgress(
    task,
    runId,
    hasResidentTaskBacking,
    readResidentTaskFlow,
  );
  if (!progress) {
    return;
  }
  let batch = taskProgressBatches.get(progress.key);
  if (!batch) {
    if (taskProgressBatches.size >= MAX_PROGRESS_BATCHES) {
      taskRegistryLog.warn("Background progress queue is full; activity remains in Tasks");
      return;
    }
    batch = {
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      requesterSessionKey: progress.entry.requesterSessionKey,
      requesterAgentId: progress.owner.agentId,
      requesterSessionId: progress.requesterSessionId,
      operationId: progress.operationId,
      origin: { ...progress.owner.requesterOrigin },
      abortController: new AbortController(),
      members: new Map(),
      pendingItems: new Map(),
      revision: 0,
    };
    taskProgressBatches.set(progress.key, batch);
  }
  if (!batch.members.has(task.taskId) && batch.members.size >= MAX_PROGRESS_BATCH_MEMBERS) {
    for (const [taskId] of batch.members) {
      const previous = tasks.get(taskId);
      if (!previous || isTerminalTaskStatus(previous.status)) {
        batch.members.delete(taskId);
        if (batch.members.size < MAX_PROGRESS_BATCH_MEMBERS) {
          break;
        }
      }
    }
  }
  if (!batch.members.has(task.taskId) && batch.members.size >= MAX_PROGRESS_BATCH_MEMBERS) {
    return;
  }
  batch.members.set(task.taskId, {
    runId,
    taskRunId: progress.entry.taskRunId ?? progress.entry.runId,
    generation: progress.generation,
    childSessionKey: progress.entry.childSessionKey,
    progressOrigin: progress.entry.progressOrigin,
  });
  if (prepared && progress.operationId) {
    const itemKey = JSON.stringify([task.taskId, progress.generation, prepared.itemId]);
    batch.pendingItems.delete(itemKey);
    batch.pendingItems.set(itemKey, {
      item: prepared,
      source: {
        taskId: task.taskId,
        runId,
        generation: progress.generation,
        label: formatTaskStatusTitleText(task.label, "Subagent"),
      },
    });
    trimPendingItems(batch);
  }
  batch.revision += 1;
  scheduleProgressBatch(progress.key, batch);
}

function trimPendingItems(batch: TaskProgressBatch): void {
  while (batch.pendingItems.size > MAX_PENDING_PROGRESS_ITEMS) {
    const oldest = batch.pendingItems.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    batch.pendingItems.delete(oldest);
  }
}

export async function getTaskProgressBatchesForRuns(entries: readonly SubagentRunRecord[]) {
  const read = await prepareTaskBackingRead();
  if (!read) {
    return [];
  }
  const generations = new Map(entries.map((entry) => [entry.runId, entry.generation]));
  for (const entry of entries) {
    scheduleYieldedSubagentRunProgress(entry);
  }
  return [...taskProgressBatches].flatMap(([key, batch]) =>
    batch.operationId &&
    [...batch.members.values()].some(
      (member) => generations.get(member.runId) === member.generation,
    ) &&
    prepareProgressBatch(key, batch, read)
      ? [{ key, batch }]
      : [],
  );
}

export function recordRequesterTaskProgress(
  key: string,
  batch: TaskProgressBatch,
  update: { kind: "item"; item: AgentActivityItem } | { kind: "plan"; plan: TaskProgressPlan },
): void {
  const requester = batch.requesterContinuation;
  if (
    !requester ||
    !requester.isCurrent() ||
    !prepareProgressBatch(key, batch, residentProgressRead)
  ) {
    return;
  }
  if (update.kind === "plan") {
    batch.pendingPlan = update.plan;
  } else {
    const itemId = `requester:${requester.runId}:${update.item.itemId}`;
    batch.pendingItems.delete(itemId);
    batch.pendingItems.set(itemId, {
      item: {
        ...update.item,
        itemId,
        ...(update.item.toolCallId
          ? { toolCallId: `requester:${requester.runId}:${update.item.toolCallId}` }
          : {}),
      },
    });
    trimPendingItems(batch);
  }
  batch.revision += 1;
  scheduleProgressBatch(key, batch);
}

export async function flushTaskProgressBatch(key: string, batch: TaskProgressBatch): Promise<void> {
  clearTimeout(batch.timer);
  batch.timer = undefined;
  await batch.publication;
  if (taskProgressBatches.get(key) === batch) {
    clearTimeout(batch.timer);
    batch.timer = undefined;
    await publishProgressBatch(key, batch);
  }
}

function scheduleProgressBatch(key: string, batch: TaskProgressBatch, immediate = false) {
  if (batch.publication || (batch.timer && !immediate)) {
    return;
  }
  clearTimeout(batch.timer);
  batch.timer = setTimeout(
    () => {
      batch.timer = undefined;
      void publishProgressBatch(key, batch);
    },
    immediate ? 0 : YIELDED_PROGRESS_COALESCE_MS,
  );
  batch.timer.unref?.();
}

function retireProgressBatch(key: string, batch: TaskProgressBatch) {
  if (taskProgressBatches.get(key) !== batch) {
    return;
  }
  taskProgressBatches.delete(key);
  clearTimeout(batch.timer);
  batch.abortController.abort();
}

export function reconcileTaskProgressBatches(event?: TaskRegistryObserverEvent): void {
  const taskId =
    event?.kind === "upserted"
      ? event.task.taskId
      : event?.kind === "deleted"
        ? event.taskId
        : undefined;
  for (const [key, batch] of taskProgressBatches) {
    if (taskId && !batch.members.has(taskId)) {
      continue;
    }
    const current = prepareProgressBatch(key, batch, residentProgressRead);
    if (!current) {
      retireProgressBatch(key, batch);
    } else if (event || current.complete) {
      if (event) {
        batch.revision += 1;
      }
      scheduleProgressBatch(
        key,
        batch,
        current.complete || (event?.kind === "upserted" && isTerminalTaskStatus(event.task.status)),
      );
    }
  }
  if (event?.kind === "upserted") {
    const task = tasks.get(event.task.taskId);
    if (task?.runtime === "subagent" && task.childSessionKey) {
      const entry = getLatestSubagentRunByChildSessionKey(task.childSessionKey);
      if (entry) {
        enqueueYieldedTaskProgress(task, entry.runId);
      }
    }
  } else if (event?.kind === "restored") {
    for (const entry of subagentRuns.values()) {
      if (entry.requesterSettleWake?.requesterYieldBatch) {
        scheduleYieldedSubagentRunProgress(entry);
      }
    }
  }
}

export function retireTaskProgressForSession(mutation: SessionIdentityMutation): void {
  for (const [key, batch] of taskProgressBatches) {
    if (batch.requesterAgentId && batch.requesterAgentId !== mutation.agentId) {
      continue;
    }
    if (
      mutation.previous.sessionKeys.includes(batch.requesterSessionKey) ||
      (mutation.kind !== "delete" &&
        mutation.current.sessionKeys.includes(batch.requesterSessionKey))
    ) {
      retireProgressBatch(key, batch);
    }
  }
}

async function ensureProgressTyping(key: string, batch: TaskProgressBatch): Promise<void> {
  if (batch.typingStarted || batch.abortController.signal.aborted) {
    return;
  }
  const read = await prepareTaskBackingRead();
  const current = read && prepareProgressBatch(key, batch, read);
  const requesterSessionId = batch.requesterSessionId;
  const operationId = batch.operationId;
  if (
    !current ||
    !operationId ||
    !requesterSessionId ||
    !current.owner.agentId ||
    !current.origin.channel ||
    !getChannelPlugin(current.origin.channel)?.heartbeat?.sendTypingGuarded
  ) {
    return;
  }
  try {
    const { startTaskProgressTyping } = await loadProgressRuntime();
    if (!read || !prepareProgressBatch(key, batch, read)) {
      return;
    }
    batch.typingStarted = startTaskProgressTyping({
      operationId,
      requesterSessionId,
      agentId: current.owner.agentId,
      sessionKey: current.sessionKey,
      origin: current.origin,
      signal: AbortSignal.any([batch.abortController.signal, getGatewayRestartDrainSignal()]),
      prepareCurrent: async () => {
        const currentRead = await prepareTaskBackingRead();
        if (!currentRead) {
          throw new Error("Task progress typing owner retired");
        }
        return () => {
          if (!prepareProgressBatch(key, batch, currentRead)) {
            throw new Error("Task progress typing owner retired");
          }
        };
      },
      isExecutionActive: () => {
        if (batch.requesterContinuation?.isCurrent()) {
          return true;
        }
        for (const member of batch.members.values()) {
          const entry = subagentRuns.get(member.runId);
          if (entry?.generation === member.generation && isSubagentRunLive(entry)) {
            return true;
          }
        }
        return false;
      },
      onStopped: () => {
        batch.typingStarted = false;
      },
      onError: (error) => {
        taskRegistryLog.debug("Background typing stopped", { error });
      },
    });
  } catch (error) {
    taskRegistryLog.debug("Background typing was unavailable", { error });
  }
}

function publishProgressBatch(key: string, batch: TaskProgressBatch): Promise<void> {
  if (batch.publication) {
    return batch.publication;
  }
  const revision = batch.revision;
  const settlePublication = async () => {
    let reschedule = false;
    try {
      reschedule = await finalizeProgressBatch(key, batch, revision);
    } finally {
      if (batch.publication === publication) {
        batch.publication = undefined;
        if (reschedule && taskProgressBatches.get(key) === batch) {
          scheduleProgressBatch(key, batch);
        }
      }
    }
  };
  const publication = runProgressPublication(key, batch).then(
    settlePublication,
    async (error: unknown) => {
      await settlePublication();
      throw error;
    },
  );
  batch.publication = publication;
  return publication;
}

async function finalizeProgressBatch(
  key: string,
  batch: TaskProgressBatch,
  revision: number,
): Promise<boolean> {
  try {
    if (taskProgressBatches.get(key) !== batch) {
      return false;
    }
    const read = await prepareTaskBackingRead();
    if (!read) {
      return true;
    }
    const current = prepareProgressBatch(key, batch, read);
    if (!current || ((!batch.operationId || current.complete) && batch.revision === revision)) {
      retireProgressBatch(key, batch);
      return false;
    }
    return batch.revision !== revision;
  } catch (error) {
    retireProgressBatch(key, batch);
    taskRegistryLog.debug("Progress owner could not settle", { error: formatErrorMessage(error) });
    return false;
  }
}

async function runProgressPublication(key: string, batch: TaskProgressBatch): Promise<void> {
  try {
    if (batch.operationId && getGlobalHookRunner()?.hasHooks("reply_payload_sending")) {
      return;
    }
    await runWithGatewayDetachedWorkContinuation(async () => {
      const read = await prepareTaskBackingRead();
      const fresh = read && prepareProgressBatch(key, batch, read);
      if (!read || !fresh || fresh.rows.length === 0) {
        return null;
      }
      const assertCurrent = () => {
        const current = prepareProgressBatch(key, batch, read);
        if (!current || current.membersKey !== fresh.membersKey) {
          throw new Error("Background progress was superseded before delivery");
        }
      };
      const progressRuntime = batch.operationId ? await loadProgressRuntime() : undefined;
      const identity =
        batch.operationId && batch.requesterSessionId && fresh.owner.agentId
          ? {
              operationId: batch.operationId,
              requesterSessionId: batch.requesterSessionId,
              sessionKey: fresh.sessionKey,
              agentId: fresh.owner.agentId,
            }
          : undefined;
      assertCurrent();
      const initialSnapshot = identity && progressRuntime?.readTaskProgressSnapshot(identity);
      if (batch.operationId && !initialSnapshot) {
        return null;
      }
      const capturedItems = [...batch.pendingItems].filter(([, { source }]) => {
        if (!source) {
          return true;
        }
        // A committed rebind can preserve the backing generation while retiring this member.
        return fresh.rows.some(
          ({ task, entry }) =>
            task.taskId === source.taskId &&
            entry.runId === source.runId &&
            entry.generation === source.generation,
        );
      });
      const capturedPlan = batch.pendingPlan;
      const { prepareProgressContent } = await loadProgressPresentation();
      const presentation = await prepareProgressContent(
        key,
        fresh.origin,
        fresh.rows,
        initialSnapshot,
        { items: capturedItems.map(([, update]) => update), plan: capturedPlan },
      );
      if (!presentation?.content) {
        return null;
      }
      assertCurrent();
      if (identity && progressRuntime) {
        const origin = fresh.rows[0]?.entry.progressOrigin;
        const publication = await progressRuntime.publishTaskProgressMessage({
          ...identity,
          origin: fresh.origin,
          sourceMessageId: origin?.messageId,
          sourceChannelId: origin?.channelId,
          content: presentation.content,
          previousContent: batch.lastPublishedContent,
          snapshot: presentation.snapshot,
          signal: AbortSignal.any([batch.abortController.signal, getGatewayRestartDrainSignal()]),
          assertCurrent,
        });
        if (publication !== "sent" && publication !== "unchanged") {
          return null;
        }
      } else {
        const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
        assertCurrent();
        const idempotencyKey = `task-progress:${createHash("sha256").update(key).digest("hex")}:${Date.now()}`;
        await sendMessage({
          channel: fresh.origin.channel,
          to: fresh.origin.to ?? "",
          accountId: fresh.origin.accountId,
          threadId: fresh.origin.threadId,
          content: presentation.content,
          agentId: fresh.owner.agentId,
          idempotencyKey,
          mirror: {
            sessionKey: fresh.sessionKey,
            agentId: fresh.owner.agentId,
            idempotencyKey,
          },
          skipQueue: true,
          gatewayOwnedDelivery: true,
          abortSignal: AbortSignal.any([
            batch.abortController.signal,
            getGatewayRestartDrainSignal(),
          ]),
          assertDirectAdapterHandoff: assertCurrent,
          onPlatformSendDispatch: async () => assertCurrent(),
        });
      }
      batch.lastPublishedContent = presentation.content;
      for (const [itemId, update] of capturedItems) {
        if (batch.pendingItems.get(itemId) === update) {
          batch.pendingItems.delete(itemId);
        }
      }
      if (batch.pendingPlan === capturedPlan) {
        batch.pendingPlan = undefined;
      }
      await ensureProgressTyping(key, batch);
      return null;
    }, "tasks:progress");
  } catch (error) {
    taskRegistryLog.debug(
      "Background progress update could not finish; task completion is unaffected",
      {
        error: formatErrorMessage(error),
      },
    );
  }
}
