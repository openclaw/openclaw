import { getAgentRunContext, getAgentRunContextOwnership } from "../infra/agent-run-registry.js";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { getTaskRegistryProcessState } from "../tasks/task-registry.process-state.js";
import type { TaskRegistryObserverEvent } from "../tasks/task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "../tasks/task-registry.types.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import { mapTaskSummary, type TaskEventPayload } from "./server-methods/task-summary.js";
import { resolveTaskRequesterSessionTarget } from "./task-session-access.js";
import type { TerminalSessionManager } from "./terminal/session-manager.js";

type TaskPublication = { summary: string };
type PendingTaskClose = { taskId: string; deleted: boolean; parent?: PendingTaskClose };

function sameTaskOwner(current: TaskRecord, observed: Omit<TaskRecord, "detail">): boolean {
  return (
    current.createdAt === observed.createdAt &&
    current.runtime === observed.runtime &&
    current.ownerKey === observed.ownerKey &&
    current.scopeKind === observed.scopeKind &&
    current.runId === observed.runId &&
    current.childSessionKey === observed.childSessionKey &&
    current.agentId === observed.agentId &&
    current.requesterSessionKey === observed.requesterSessionKey &&
    current.requesterAgentId === observed.requesterAgentId
  );
}

/** Owns task publications and their terminal-session effects for one Gateway. */
export function startGatewayTaskSubscriptions(params: {
  log: SubsystemLogger;
  broadcast: GatewayBroadcastFn;
  terminalSessions: Pick<TerminalSessionManager, "closeTaskSessions">;
}): () => Promise<void> {
  let disposed = false;
  const state = getTaskRegistryProcessState();
  const publications = new Map<string, TaskPublication>();
  let pendingClose: PendingTaskClose | undefined;
  const registered = Promise.all([
    import("../tasks/task-registry.store.js"),
    import("../tasks/task-backing-authority.js"),
  ]).then(([runtime, { readTaskBackingInstance }]) => {
    const observers = {
      onEvent: (event: TaskRegistryObserverEvent) => {
        const taskId =
          event.kind === "upserted"
            ? event.task.taskId
            : event.kind === "deleted"
              ? event.taskId
              : undefined;
        const terminalId =
          event.kind === "upserted" &&
          isTerminalTaskStatus(event.task.status) &&
          (!event.previous || !isTerminalTaskStatus(event.previous.status))
            ? event.task.taskId
            : undefined;
        const runOwner = taskId ? state.runOwners.get(taskId) : undefined;
        const backing = taskId
          ? JSON.stringify(readTaskBackingInstance(state.tasks.get(taskId)?.detail))
          : undefined;
        const runId = terminalId && event.kind === "upserted" ? event.task.runId : undefined;
        const context = runId ? getAgentRunContext(runId) : undefined;
        const authority = context?.delegatedAuthority;
        const instance = authority?.operationalRunInstance;
        const ownership = runId ? getAgentRunContextOwnership(runId) : undefined;
        const isCurrent = () => {
          if (disposed || runtime.getTaskRegistryObservers() !== observers) {
            return false;
          }
          if (event.kind === "restored") {
            return true;
          }
          const current = state.tasks.get(
            event.kind === "upserted" ? event.task.taskId : event.taskId,
          );
          if (event.kind === "deleted") {
            return current === undefined;
          }
          const currentContext = runId ? getAgentRunContext(runId) : undefined;
          const currentAuthority = currentContext?.delegatedAuthority;
          const currentOwnership = runId ? getAgentRunContextOwnership(runId) : undefined;
          const currentRunOwner = state.runOwners.get(event.task.taskId);
          return (
            current !== undefined &&
            sameTaskOwner(current, event.task) &&
            JSON.stringify(readTaskBackingInstance(current.detail)) === backing &&
            (!isTerminalTaskStatus(event.task.status) || isTerminalTaskStatus(current.status)) &&
            (!currentRunOwner || currentRunOwner === runOwner) &&
            // Retirement is allowed; replacement cannot inherit an earlier terminal close.
            (!currentContext || currentContext === context) &&
            (!currentAuthority ||
              (currentAuthority === authority &&
                currentAuthority.operationalRunInstance === instance)) &&
            (!currentOwnership || currentOwnership === ownership)
          );
        };
        if (!isCurrent()) {
          return;
        }
        let payload: TaskEventPayload;
        let target: ReturnType<typeof resolveTaskRequesterSessionTarget>;
        let rollback: (() => void) | undefined;
        switch (event.kind) {
          case "upserted": {
            const task = mapTaskSummary(event.task);
            target = resolveTaskRequesterSessionTarget(event.task);
            const summary = JSON.stringify([task, target]);
            const previous = publications.get(task.id);
            if (previous?.summary === summary) {
              return;
            }
            const publication = { summary };
            publications.set(task.id, publication);
            rollback = () => {
              // A nested publication can return to the same summary with a different owner.
              if (publications.get(task.id) === publication) {
                if (previous) {
                  publications.set(task.id, previous);
                } else {
                  publications.delete(task.id);
                }
              }
            };
            payload = { action: "upserted", task };
            break;
          }
          case "deleted":
            // A reentrant delete retires active closes even if that task ID is republished.
            for (let closing = pendingClose; closing; closing = closing.parent) {
              if (closing.taskId === event.taskId) {
                closing.deleted = true;
              }
            }
            publications.delete(event.taskId);
            payload = { action: "deleted", taskId: event.taskId };
            target = resolveTaskRequesterSessionTarget(event.previous);
            break;
          case "restored":
            publications.clear();
            payload = { action: "restored" };
            break;
        }
        if (!isCurrent()) {
          rollback?.();
          return;
        }
        const closing: PendingTaskClose | undefined = terminalId
          ? { taskId: terminalId, deleted: false, parent: pendingClose }
          : undefined;
        if (closing) {
          pendingClose = closing;
        }
        let broadcastCompleted = false;
        try {
          params.broadcast("task", payload, {
            dropIfSlow: true,
            ...(target ? { sessionKeys: [target.sessionKey], agentId: target.agentId } : {}),
          });
          broadcastCompleted = true;
          if (closing && !closing.deleted && isCurrent()) {
            params.terminalSessions.closeTaskSessions(closing.taskId);
          }
        } catch (error) {
          if (!broadcastCompleted) {
            rollback?.();
          }
          throw error;
        } finally {
          if (closing) {
            pendingClose = closing.parent;
          }
        }
      },
    };
    if (!disposed) {
      runtime.configureTaskRegistryRuntime({ observers });
    }
    return { runtime, observers };
  });
  void registered.catch((error: unknown) => {
    params.log.warn("Task registry observer registration failed", { error });
  });
  return () => {
    disposed = true;
    return registered
      .then(({ runtime, observers }) => {
        if (runtime.getTaskRegistryObservers() === observers) {
          runtime.configureTaskRegistryRuntime({ observers: null });
        }
      })
      .catch(() => undefined);
  };
}
