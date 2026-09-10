import { randomUUID } from "node:crypto";
import { inspectNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { getSupervisedCommandResources } from "./supervised-command-custody.js";
import { reconcileSupervisedCommandResources } from "./supervised-command-recovery.js";
import { reconcileSupervisedOperationCapacity } from "./supervised-operation.capacity.js";
import { launchSupervisedOperationProcess } from "./supervised-operation.launch.js";
import {
  getSupervisedOperationExecution,
  reconcileSupervisedOperationRecords,
  listSupervisedOperations,
  markSupervisedOperationReconciling,
  resolveSupervisedOperationReconciliation,
} from "./supervised-operation.store.js";
import type { SupervisedWorkflowDatabaseOptions as Options } from "./supervised-workflow.persistence.js";
import { getSupervisedWorkflowContract } from "./supervised-workflow.store.js";

/** Database polling is the wake fallback: a lost completion event cannot strand a task. */
export function startSupervisedOperationDispatcher(params: {
  options?: Options;
  onlyFlowId?: string;
  canDispatch?: () => boolean;
  onError: (error: unknown) => void;
}) {
  const options = params.options ?? {};
  let stopped = false;
  let busy = false;
  const cleanupOwner = randomUUID();
  let cleanupCursor: string | undefined;
  const launchedAt = new Map<string, number>();
  const report = (error: unknown) => {
    try {
      params.onError(error);
    } catch {
      /* Observer is not authority. */
    }
  };
  const tick = async () => {
    if (stopped || busy || params.canDispatch?.() === false) {
      return;
    }
    busy = true;
    try {
      reconcileSupervisedOperationRecords(Date.now(), options, params.onlyFlowId);
      const resources = await reconcileSupervisedCommandResources({
        options,
        onlyFlowId: params.onlyFlowId,
        ownerId: cleanupOwner,
        afterExecutionId: cleanupCursor,
        onError: report,
        assertCleanupCurrent: () => {
          if (stopped || params.canDispatch?.() === false) {
            throw new Error("Dispatcher cleanup authority closed");
          }
        },
      });
      cleanupCursor = resources.nextExecutionId;
      for (const error of reconcileSupervisedOperationCapacity(Date.now(), options)) {
        report(error);
      }
      const operations = listSupervisedOperations(options, params.onlyFlowId).filter(
        (operation) => !operation.outcome,
      );
      const queuedIds = new Set(operations.map((operation) => operation.operationId));
      for (const key of launchedAt.keys()) {
        if (!queuedIds.has(key)) {
          launchedAt.delete(key);
        }
      }
      let launches = 0;
      for (let operation of operations) {
        if (stopped || params.canDispatch?.() === false) {
          break;
        }
        try {
          const now = Date.now();
          if (
            operation.state === "queued" &&
            operation.dueAt <= now &&
            launches < 2 &&
            now - (launchedAt.get(operation.operationId) ?? 0) >= 10_000
          ) {
            launchedAt.set(operation.operationId, now);
            launches += 1;
            await launchSupervisedOperationProcess(operation.operationId, options);
            continue;
          }
          if (operation.executionId && ["running", "reconciling"].includes(operation.state)) {
            const execution = getSupervisedOperationExecution(operation.executionId, options);
            if (!execution || execution.outcome || execution.leaseExpiresAt > now) {
              continue;
            }
            operation = markSupervisedOperationReconciling(execution, now, options);
            const reviewResources =
              operation.request.kind === "review"
                ? getSupervisedCommandResources(execution.executionId, options)
                : undefined;
            if (
              operation.request.kind === "review" &&
              ((reviewResources && reviewResources.state !== "closed") ||
                (execution.dispatchedAt !== null && !reviewResources))
            ) {
              // Deadline is a logical fact, not proof of runtime extinction.
              // Physical recovery runs independently above, including on later ticks.
              continue;
            }
            if (now >= operation.deadlineAt) {
              resolveSupervisedOperationReconciliation(
                operation,
                {
                  outcome: {
                    status: "input_required",
                    summary:
                      "Operation deadline expired without a definitive receipt; resource cleanup remains independently tracked",
                    facts: { executionId: execution.executionId, cleanup: "unverified" },
                    artifacts: [],
                  },
                },
                now,
                options,
              );
              continue;
            }
            const physical = execution.process
              ? inspectNodeWorkerProcessIdentity(execution.process)
              : "unknown";
            const contract = getSupervisedWorkflowContract(
              operation.flowId,
              operation.episode,
              options,
            );
            const profile = contract?.contract.profiles.find(
              (item) => item.id === operation.request.profile,
            );
            const executionResources = getSupervisedCommandResources(
              execution.executionId,
              options,
            );
            const resourcesClosed =
              !executionResources ||
              getSupervisedCommandResources(execution.executionId, options)?.state === "closed";
            if (stopped || params.canDispatch?.() === false) {
              break;
            }
            if (execution.dispatchedAt === null && resourcesClosed) {
              // SQL state has fenced even a live but stale pre-dispatch owner.
              resolveSupervisedOperationReconciliation(
                operation,
                {
                  retryAt: now + 1000,
                  evidence: "Exact expired execution never reserved dispatch",
                },
                now,
                options,
              );
            } else if (
              resourcesClosed &&
              (physical === "dead" || physical === "reused") &&
              (profile?.kind === "review" ||
                profile?.kind === "publication" ||
                profile?.kind === "ci" ||
                profile?.kind === "command")
            ) {
              // Computations run on pinned inputs; writable commands produce a
              // private draft, never effects in the accepted input workspace.
              const evidence =
                profile?.kind === "publication"
                  ? `Exact runner is ${physical}; successor must reconcile the immutable commit and PR marker before any external action`
                  : `Exact runner is ${physical}; recompute from the pinned input without adopting an unaccepted draft`;
              resolveSupervisedOperationReconciliation(
                operation,
                { retryAt: now + 1000, evidence },
                now,
                options,
              );
            }
          }
        } catch (error) {
          // A broken operation must not stop every other task's dispatcher.
          report(error);
        }
      }
    } catch (error) {
      report(error);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  void tick();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
    tick,
  };
}
