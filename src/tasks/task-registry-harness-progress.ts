import { createHash, randomUUID } from "node:crypto";
import { getAgentRunLifecycleGeneration } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayDetachedWorkContinuation,
} from "../process/gateway-work-admission.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { canDeliverToRequesterOrigin } from "./task-notification-routing.js";
import { sendOrEditTaskProgressMessage } from "./task-progress-message.js";
import { loadTaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";
import { taskProgressBatches, taskRegistryLog } from "./task-registry-state.js";
import type { TaskProgressBatch } from "./task-registry.process-state.js";
import {
  isTerminalTaskStatus,
  type TaskDeliveryState,
  type TaskRecord,
} from "./task-registry.types.js";
import { formatTaskStatusTitleText } from "./task-status.js";

const HARNESS_PROGRESS_COALESCE_MS = 15_000;
const MAX_PROGRESS_BATCHES = 128;
const MAX_PROGRESS_BATCH_MEMBERS = 32;
const MAX_PROGRESS_DISPLAY_MEMBERS = 8;

/** A host-issued harness owner permits only bounded task-state presentation. */
export function registerHarnessTaskProgress(params: {
  readTasks: () => TaskRecord[];
  isCurrent: () => boolean;
  verifyRequester?: (assertCurrent: () => void) => Promise<boolean>;
  owner: {
    sessionKey: string;
    agentId?: string;
    requesterOrigin: TaskDeliveryState["requesterOrigin"];
  };
  onStopped: () => void;
}): { notify: () => void; dispose: () => void } | undefined {
  if (taskProgressBatches.size >= MAX_PROGRESS_BATCHES) {
    taskRegistryLog.warn("Background progress queue is full; activity remains in Tasks");
    return undefined;
  }
  const key = `harness:${randomUUID()}`;
  const origin = { ...params.owner.requesterOrigin };
  const batch: TaskProgressBatch = {
    lifecycleGeneration: getAgentRunLifecycleGeneration(),
    requesterSessionKey: params.owner.sessionKey,
    requesterAgentId: params.owner.agentId,
    origin,
    abortController: new AbortController(),
    members: new Map(),
    pendingItems: new Map(),
    revision: 0,
  };
  let stopped = false;
  const dispose = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearTimeout(batch.timer);
    batch.abortController.abort();
    if (taskProgressBatches.get(key) === batch) {
      taskProgressBatches.delete(key);
    }
    params.onStopped();
  };
  batch.harness = {
    ...params,
    owner: { ...params.owner, requesterOrigin: origin },
    stop: dispose,
  };
  let rows: TaskRecord[];
  try {
    rows = params.readTasks();
  } catch {
    params.onStopped();
    return undefined;
  }
  if (rows.length === 0) {
    params.onStopped();
    return undefined;
  }
  taskProgressBatches.set(key, batch);
  const notify = () => {
    if (stopped) {
      return;
    }
    try {
      if (!params.isCurrent()) {
        dispose();
        return;
      }
      const current = params.readTasks();
      if (current.length === 0) {
        dispose();
        return;
      }
      batch.members.clear();
      for (const task of current.slice(0, MAX_PROGRESS_BATCH_MEMBERS)) {
        const runId = task.runId ?? "";
        batch.members.set(task.taskId, {
          runId,
          taskRunId: runId,
          generation: 0,
          childSessionKey: task.childSessionKey ?? "",
        });
      }
      batch.revision += 1;
      scheduleHarnessTaskProgressBatch(
        key,
        batch,
        current.every((row) => isTerminalTaskStatus(row.status)),
      );
    } catch {
      dispose();
    }
  };
  return { notify, dispose };
}

export function notifyHarnessTaskProgress(task: TaskRecord): void {
  for (const [key, batch] of taskProgressBatches) {
    const owner = batch.harness;
    if (!owner) {
      continue;
    }
    try {
      if (!owner.isCurrent()) {
        owner.stop();
        continue;
      }
      const rows = owner.readTasks();
      if (rows.length === 0) {
        owner.stop();
      } else if (rows.some((current) => current.taskId === task.taskId)) {
        batch.revision += 1;
        scheduleHarnessTaskProgressBatch(
          key,
          batch,
          rows.every((row) => isTerminalTaskStatus(row.status)),
        );
      }
    } catch {
      owner.stop();
    }
  }
}

export function prepareHarnessProgressBatch(key: string, batch: TaskProgressBatch) {
  const harness = batch.harness;
  if (
    !harness ||
    taskProgressBatches.get(key) !== batch ||
    batch.abortController.signal.aborted ||
    batch.lifecycleGeneration !== getAgentRunLifecycleGeneration()
  ) {
    harness?.stop();
    return undefined;
  }
  let rows: TaskRecord[];
  try {
    if (!harness.isCurrent() || !canDeliverToRequesterOrigin(harness.owner.requesterOrigin)) {
      harness.stop();
      return undefined;
    }
    rows = harness.readTasks();
  } catch {
    harness.stop();
    return undefined;
  }
  if (rows.length === 0) {
    harness.stop();
    return undefined;
  }
  const terminal = rows.every((task) => isTerminalTaskStatus(task.status));
  const lines = rows.slice(0, MAX_PROGRESS_DISPLAY_MEMBERS).map((task) => {
    const observation = getTaskExecutionObservation(task);
    const currentTool = observation.currentTool?.name;
    const activity = isTerminalTaskStatus(task.status)
      ? task.status
      : observation.state === "waiting"
        ? `waiting: ${observation.wait?.kind ?? "external work"}`
        : currentTool
          ? `running ${currentTool}`
          : observation.state === "unknown"
            ? "activity unavailable"
            : "working";
    const lastAt = observation.lastActivityAt ?? task.lastEventAt;
    const last =
      lastAt === undefined
        ? "last activity unavailable"
        : `last activity ${new Date(lastAt).toISOString()}`;
    return `- ${formatTaskStatusTitleText(task.label, "Subagent task")}: ${activity}; ${last}.`;
  });
  if (rows.length > MAX_PROGRESS_DISPLAY_MEMBERS) {
    lines.push("- More task activity is available in Tasks.");
  }
  return {
    owner: harness.owner,
    rows,
    membersKey: JSON.stringify(rows.map((task) => [task.taskId, task.runId, task.createdAt])),
    content:
      `${terminal ? "Background work finished" : "Background work is in progress"}:\n${lines.join("\n")}`.slice(
        0,
        1800,
      ),
    terminal,
  };
}

export function scheduleHarnessTaskProgressBatch(
  key: string,
  batch: TaskProgressBatch,
  immediate = false,
): void {
  if (batch.publication || (batch.timer && !immediate)) {
    return;
  }
  clearTimeout(batch.timer);
  batch.timer = setTimeout(
    () => {
      batch.timer = undefined;
      void publishHarnessTaskProgressBatch(key, batch);
    },
    immediate ? 0 : HARNESS_PROGRESS_COALESCE_MS,
  );
  batch.timer.unref?.();
}

export function publishHarnessTaskProgressBatch(
  key: string,
  batch: TaskProgressBatch,
): Promise<void> {
  if (batch.publication) {
    return batch.publication;
  }
  const revision = batch.revision;
  const publication = runHarnessProgressPublication(key, batch).finally(() => {
    if (batch.publication === publication) {
      batch.publication = undefined;
    }
    if (taskProgressBatches.get(key) !== batch || !batch.harness) {
      return;
    }
    const current = prepareHarnessProgressBatch(key, batch);
    if (!current) {
      return;
    }
    if (batch.revision !== revision) {
      scheduleHarnessTaskProgressBatch(key, batch, current.terminal);
    } else if (current.terminal) {
      batch.harness.stop();
    }
  });
  batch.publication = publication;
  return publication;
}

async function runHarnessProgressPublication(key: string, batch: TaskProgressBatch): Promise<void> {
  try {
    await runWithGatewayDetachedWorkContinuation(async () => {
      const fresh = prepareHarnessProgressBatch(key, batch);
      if (!fresh) {
        return null;
      }
      const assertCurrent = () => {
        const current = prepareHarnessProgressBatch(key, batch);
        if (!current || current.membersKey !== fresh.membersKey) {
          throw new Error("Harness progress owner was superseded before delivery");
        }
      };
      if (batch.harness?.verifyRequester && !(await batch.harness.verifyRequester(assertCurrent))) {
        batch.harness.stop();
        return null;
      }
      assertCurrent();
      const runtime = await loadTaskRegistryDeliveryRuntime();
      const preferenceEnabled = await runtime.prepareTaskProgressPreferenceReader(assertCurrent);
      const isPreferenceEnabled = () =>
        preferenceEnabled(
          fresh.owner.requesterOrigin?.channel,
          fresh.owner.requesterOrigin?.accountId,
        );
      if (!isPreferenceEnabled()) {
        batch.harness?.stop();
        return null;
      }
      assertCurrent();
      if (fresh.terminal && !batch.message?.target) {
        batch.harness?.stop();
        return null;
      }
      const guardedHandoff = () => {
        assertCurrent();
        if (!isPreferenceEnabled()) {
          throw new Error("Harness progress preference changed before delivery");
        }
      };
      const idempotencyKey = `task-progress:${createHash("sha256").update(key).digest("hex")}:${Date.now()}`;
      await sendOrEditTaskProgressMessage(
        (batch.message ??= {}),
        {
          channel: fresh.owner.requesterOrigin?.channel,
          to: fresh.owner.requesterOrigin?.to ?? "",
          accountId: fresh.owner.requesterOrigin?.accountId,
          threadId: fresh.owner.requesterOrigin?.threadId,
          content: fresh.content,
          agentId: fresh.owner.agentId,
          idempotencyKey,
          mirror: {
            sessionKey: fresh.owner.sessionKey,
            agentId: fresh.owner.agentId,
            idempotencyKey,
          },
          skipQueue: true,
          gatewayOwnedDelivery: true,
          abortSignal: AbortSignal.any([
            batch.abortController.signal,
            getGatewayRestartDrainSignal(),
          ]),
          assertDirectAdapterHandoff: guardedHandoff,
          onPlatformSendDispatch: async () => guardedHandoff(),
        },
        runtime,
      );
      if (fresh.terminal) {
        batch.harness?.stop();
      }
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
