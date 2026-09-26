import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { isBackgroundExecTask } from "./background-exec-task-contract.js";
import { CRON_TASK_KIND } from "./cron-task-contract.js";
import { SUBAGENT_KILL_TASK_ERROR } from "./detached-task-runtime-contract.js";
import { isHarnessOwnedSubagentTask } from "./harness-owned-subagent-task.js";
import { hasResidentTaskBacking, prepareTaskBackingRead } from "./task-backing-authority.js";
import { readManagedTaskBacking, readTaskBackingInstance } from "./task-backing-records.js";
import {
  prepareTaskCancellationControl,
  prepareTaskCancellationRead,
  withTaskCancellationControl,
  type TaskCancellationControl,
} from "./task-cancellation-context.js";
import { captureTaskCancellationSelection } from "./task-cancellation-selection.capture.js";
import { matchesTaskCancellationSelection } from "./task-cancellation-selection.js";
import { isProvisionalSubagentKillTask } from "./task-cancellation-state.js";
import { captureTaskMutationContext } from "./task-executor-mutation-effects.async.js";
import { ensureLinkedTaskFlowRegistryReady } from "./task-registry-flow-link.js";
import { cloneTaskRecord } from "./task-registry-records.js";
import { loadTaskRegistryControlRuntime } from "./task-registry-runtime-loaders.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunScope,
  withTaskRegistryMutation,
  tasks,
} from "./task-registry-state.js";
import {
  isTerminalTaskStatus,
  type TaskRecord,
  type TaskRunStateTransitionParams,
} from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

export type TaskCancellationResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskRecord;
};

export async function cancelTaskById(params: {
  cfg: OpenClawConfig;
  taskId: string;
  reason?: string;
}): Promise<TaskCancellationResult> {
  const taskId = params.taskId.trim();
  let selection: ReturnType<typeof captureTaskCancellationSelection> | undefined;
  const notCancelled = (reason: string): TaskCancellationResult => {
    const current = tasks.get(taskId);
    return {
      found: true,
      cancelled: false,
      reason,
      ...(current ? { task: cloneTaskRecord(current) } : {}),
    };
  };
  try {
    for (
      let pending = prepareTaskCancellationRead();
      pending;
      pending = prepareTaskCancellationRead()
    ) {
      await pending;
    }
    let read = await prepareTaskBackingRead(taskId);
    if (!read) {
      return notCancelled("Task persistence preparation did not settle.");
    }
    const initial = read.getTaskById(taskId);
    if (!initial) {
      return { found: false, cancelled: false, reason: "Task not found." };
    }
    selection = captureTaskCancellationSelection(initial);
    const task = selection.task;
    let provisional = isProvisionalSubagentKillTask(task);
    if (!provisional && isTerminalTaskStatus(task.status)) {
      return { found: true, cancelled: false, reason: "Task is already terminal.", task };
    }
    const creation = captureTaskMutationContext();
    const inherited = prepareTaskCancellationControl(task);
    const runOwner = getTaskRunOwner(task);
    const assertCurrent = () => {
      creation.assertStores();
      inherited?.assertCurrent();
      const current = tasks.get(taskId);
      if (
        !current ||
        !matchesTaskCancellationSelection(current, task) ||
        getTaskRunOwner(current) !== runOwner
      ) {
        throw new Error("Task changed while cancellation was in progress.");
      }
      prepareTaskCancellationControl(current)?.assertCurrent();
      if (!hasResidentTaskBacking(current)) {
        throw new Error("Task backing ownership could not be verified.");
      }
    };
    const refresh = async () => {
      read = await prepareTaskBackingRead(taskId);
      if (!read) {
        throw new Error("Task persistence preparation did not settle.");
      }
      read.assertCurrent();
      const current = read.getTaskById(taskId);
      if (!current || !read.hasAuthoritativeTaskBacking(current)) {
        throw new Error("Task backing ownership could not be verified.");
      }
      assertCurrent();
    };
    const control: TaskCancellationControl = {
      assertCurrent,
      prepareRead() {
        const pending = inherited?.prepareRead?.();
        if (pending) {
          return pending;
        }
        // Only projection freshness can be repaired. Live authority failures remain failures.
        inherited?.assertCurrent();
        try {
          read?.assertCurrent();
          read?.getTaskById(taskId);
        } catch {
          return refresh();
        }
        return undefined;
      },
    };
    assertCurrent();
    const parentFlowId = task.parentFlowId?.trim();
    const flow = parentFlowId ? read.getTaskFlowById(parentFlowId) : undefined;
    const managedBacking =
      flow?.syncMode === "managed" ? readManagedTaskBacking(task.detail)?.instance : undefined;
    const backing = managedBacking ?? readTaskBackingInstance(task.detail);
    const requested = params.reason?.trim();
    const cancellationError =
      requested && requested !== SUBAGENT_KILL_TASK_ERROR ? requested : "Cancelled by operator.";
    const childSessionKey = task.childSessionKey?.trim();
    const transition = async (
      state: Omit<TaskRunStateTransitionParams, "runId">,
      additionalGuard?: () => void,
    ) => {
      const guard = () => {
        assertCurrent();
        additionalGuard?.();
      };
      const input = {
        ...state,
        runId: task.runId ?? "",
        runtime: task.runtime,
        sessionKey: childSessionKey,
      };
      let updated: TaskRecord[];
      if (task.runId?.trim()) {
        const { transitionTaskRecordsByRunAsync } =
          await import("./task-registry-transition.async.js");
        guard();
        updated = await transitionTaskRecordsByRunAsync(
          {
            kind: "state",
            params: { ...input, ...(task.runtime === "subagent" ? {} : { taskId }) },
          },
          guard,
        );
      } else {
        const { transitionTaskCancellationRowAsync } =
          await import("./task-cancellation-transition.async.js");
        guard();
        updated = await transitionTaskCancellationRowAsync(task, input, guard);
      }
      return updated.find((candidate) => candidate.taskId === taskId);
    };
    const promote = async (additionalGuard?: () => void): Promise<TaskCancellationResult> => {
      await refresh();
      additionalGuard?.();
      const current = read?.getTaskById(taskId);
      if (!current) {
        return notCancelled("Task changed while cancellation was in progress.");
      }
      const now = Date.now();
      const updated = await transition(
        {
          status: "cancelled",
          endedAt: provisional ? (current.endedAt ?? now) : now,
          lastEventAt: now,
          error: cancellationError,
        },
        additionalGuard,
      );
      return updated
        ? { found: true, cancelled: true, task: updated }
        : notCancelled("Task persistence failed or its terminal outcome changed.");
    };
    if (isBackgroundExecTask(task)) {
      const processSessionId = task.sourceId?.trim();
      const { cancelBackgroundExecSession } = await loadTaskRegistryControlRuntime();
      await refresh();
      read?.assertCurrent();
      assertCurrent();
      if (!processSessionId || !cancelBackgroundExecSession(processSessionId)) {
        return notCancelled("Background command has no active cancellation handle.");
      }
    } else if (task.runtime === "cli") {
      if (!runOwner) {
        return notCancelled(
          "Task has no live run owner. Use openclaw tasks audit to inspect its state.",
        );
      }
      assertCurrent();
      const result = await withTaskCancellationControl(control, () =>
        runOwner.cancel(cancellationError),
      );
      return result.ok
        ? { found: true, cancelled: true, task: result.value }
        : notCancelled(result.error);
    } else if (task.runtime === "cron") {
      const { cancelActiveCronTaskRun } = await loadTaskRegistryControlRuntime();
      await refresh();
      read?.assertCurrent();
      assertCurrent();
      if (
        !cancelActiveCronTaskRun({
          runId: task.runId,
          reason: requested || "Cancelled by operator.",
        }) &&
        (task.taskKind === CRON_TASK_KIND || childSessionKey)
      ) {
        return notCancelled("Cron task has no active cancellation handle.");
      }
      // Unmarked childless rows retain the legacy cleanup contract.
    } else if (!childSessionKey) {
      return notCancelled(
        isHarnessOwnedSubagentTask(task)
          ? "This subagent is controlled by its native harness. Use the parent session's native collaboration tools to stop it."
          : "Task has no cancellable child session.",
      );
    } else if (task.runtime === "acp") {
      const { getAcpSessionManager } = await loadTaskRegistryControlRuntime();
      await refresh();
      if (backing?.runtime !== "acp") {
        return notCancelled(
          "ACP task execution cannot be verified. Select its current task or use ACP session controls.",
        );
      }
      await withTaskCancellationControl(control, () =>
        getAcpSessionManager().cancelSession({
          cfg: params.cfg,
          sessionKey: childSessionKey,
          agentId: task.agentId,
          reason: requested || "task-cancel",
          expectedRunId: task.runId,
          expectedInstanceId: backing.instanceId,
          ...(managedBacking?.runtime === "acp" ? { expectedOwnerKey: task.ownerKey } : {}),
        }),
      );
      await refresh();
      const current = read?.getTaskById(taskId);
      if (current && isTerminalTaskStatus(current.status)) {
        return current.status === "cancelled"
          ? { found: true, cancelled: true, task: current }
          : notCancelled(`Task became ${current.status} while cancellation was in progress.`);
      }
    } else if (task.runtime === "subagent") {
      const { killSubagentRunAdmin } = await loadTaskRegistryControlRuntime();
      await refresh();
      let cancellation = notCancelled("Subagent cancellation result was not published.");
      await withTaskCancellationControl(control, () =>
        killSubagentRunAdmin(
          {
            cfg: params.cfg,
            sessionKey: childSessionKey,
            expectedTaskRunId: task.runId,
            expectedOwnerKey: task.ownerKey,
            ...(backing?.runtime === "subagent" ? { expectedGeneration: backing.generation } : {}),
          },
          {
            // Runtime dispatch consumes the full prepared control. Publication can
            // still report its native outcome when the task projection was replaced.
            assertCurrent: () => inherited?.assertCurrent(),
            async settleResult(result, assertOutcomeCurrent) {
              let reconcilingTerminal = false;
              try {
                await refresh();
                assertOutcomeCurrent();
                const current = read?.getTaskById(taskId);
                if (current && isProvisionalSubagentKillTask(current)) {
                  provisional = true;
                }
                let reason: string | undefined;
                if (current?.status === "succeeded") {
                  reason = "Subagent completed while cancellation was in progress.";
                } else if (
                  current &&
                  isTerminalTaskStatus(current.status) &&
                  current.status !== "cancelled"
                ) {
                  reason = `Subagent became ${current.status} while cancellation was in progress.`;
                } else if (current?.status === "cancelled" && !provisional) {
                  reason = "Subagent was cancelled while cancellation was in progress.";
                } else if (result.found && result.targetState?.state === "terminal") {
                  const terminal = result.targetState.task;
                  reconcilingTerminal = true;
                  const reconciled = await transition(terminal, assertOutcomeCurrent);
                  reconcilingTerminal = false;
                  if (!reconciled) {
                    reason =
                      "Subagent became terminal, but task state reconciliation failed to persist.";
                  } else if (
                    terminal.status === "cancelled" &&
                    terminal.error === SUBAGENT_KILL_TASK_ERROR
                  ) {
                    provisional = true;
                  } else {
                    reason =
                      terminal.status === "succeeded"
                        ? "Subagent completed while cancellation was in progress."
                        : `Subagent became ${terminal.status} while cancellation was in progress.`;
                  }
                }
                if (result.found && result.error) {
                  reason = `${reason ? `${reason} ` : ""}Subagent cancellation incomplete: ${result.error}`;
                }
                if (!reason && result.found && result.targetState?.state === "finalizing") {
                  reason = "Subagent completion is still being finalized.";
                }
                if (!reason && (!result.found || (!result.killed && !provisional))) {
                  reason = result.found ? "Subagent was not running." : "Subagent task not found.";
                }
                cancellation = reason ? notCancelled(reason) : await promote(assertOutcomeCurrent);
              } catch (error) {
                if (hasSqliteWorkerOutcomeUnknown(error)) {
                  throw error;
                }
                const reason = reconcilingTerminal
                  ? "Subagent became terminal, but task state reconciliation failed to persist."
                  : formatErrorMessage(error);
                cancellation = notCancelled(
                  result.found && result.error
                    ? `${reason} Subagent cancellation incomplete: ${result.error}`
                    : reason,
                );
              }
            },
          },
        ),
      );
      return cancellation;
    } else {
      return notCancelled("Task runtime does not support cancellation yet.");
    }
    return await promote();
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return notCancelled(formatErrorMessage(error));
  } finally {
    selection?.release();
  }
}

function ensureTaskCancellationReady(task: TaskRecord): void {
  const runId = task.runId?.trim();
  const linkedTasks =
    runId && (task.runtime === "acp" || task.runtime === "subagent")
      ? getTasksByRunScope({
          runId,
          runtime: task.runtime,
          sessionKey: task.childSessionKey,
        })
      : [task];
  for (const linkedTask of linkedTasks.length > 0 ? linkedTasks : [task]) {
    ensureLinkedTaskFlowRegistryReady(linkedTask);
  }
}

export function assertTaskCancellationReadyById(taskId: string): TaskRecord | null {
  return withTaskRegistryMutation(
    () => {
      ensureTaskRegistryReady();
      const task = tasks.get(taskId.trim());
      if (!task) {
        return null;
      }
      if (!isTerminalTaskStatus(task.status) || isProvisionalSubagentKillTask(task)) {
        ensureTaskCancellationReady(task);
      }
      return cloneTaskRecord(task);
    },
    () => null,
  );
}
