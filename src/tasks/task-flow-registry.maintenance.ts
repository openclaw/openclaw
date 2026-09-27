// Reconciles stale task-flow records with their child task state.
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { listTasksForFlowId } from "./runtime-internal.js";
import { isTaskFlowCancellationPending } from "./task-cancellation-state.js";
import { resolveTaskFlowMaintenanceAction } from "./task-flow-maintenance-policy.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditSummary,
} from "./task-flow-registry.audit.js";
import {
  getTaskFlowRegistryRestoreFailure,
  listTaskFlowRecords,
  prepareTaskFlowRegistryRead,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-registry.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  prepareTaskRegistryRead,
  prepareTaskRegistryReadOwner,
  type TaskRegistryRead,
} from "./task-registry-read.js";

/** Counts task-flow registry maintenance actions without exposing individual records. */
type TaskFlowRegistryMaintenanceSummary = {
  reconciled: number;
  pruned: number;
};

export function assertTaskFlowRegistryMaintenanceReady(): void {
  const restoreFailure = getTaskFlowRegistryRestoreFailure();
  if (restoreFailure) {
    throw new Error(
      `Task-flow registry restore failed: ${restoreFailure}. Refusing task maintenance.`,
    );
  }
}

export function getInspectableTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}

export function previewTaskFlowRegistryMaintenance(): TaskFlowRegistryMaintenanceSummary {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    const action = resolveTaskFlowMaintenanceAction(flow, now, () =>
      listTasksForFlowId(flow.flowId).some(isTaskFlowCancellationPending),
    );
    if (action?.kind === "prune") {
      pruned += 1;
    } else if (action) {
      reconciled += 1;
    }
  }
  return { reconciled, pruned };
}

export async function runTaskFlowRegistryMaintenance(): Promise<TaskFlowRegistryMaintenanceSummary> {
  const now = Date.now();
  const context = captureOpenClawStateWorkerContext();
  const store = getTaskFlowRegistryStore();
  let taskOwner: Awaited<ReturnType<typeof prepareTaskRegistryReadOwner>> | undefined;
  const assertOwnerCurrent = () => {
    context.admission.assertCurrent();
    taskOwner?.assertCurrent();
    if (getTaskFlowRegistryStore() !== store) {
      throw new Error("Task-flow maintenance owner is no longer current.");
    }
  };
  const prepareFlows = async () => {
    assertOwnerCurrent();
    const read = await prepareTaskFlowRegistryRead(context);
    assertOwnerCurrent();
    return read;
  };
  const initial = await prepareFlows();
  if (!initial) {
    throw new Error("Task-flow registry changed while preparing maintenance.");
  }
  let reconciled = 0;
  let pruned = 0;
  for (const flowId of initial.listTaskFlowIds()) {
    const selectedRead = await prepareFlows();
    if (!selectedRead?.isTaskFlowCurrent(flowId)) {
      continue;
    }
    const selected = selectedRead.getTaskFlowById(flowId);
    const selectedAction = selected && resolveTaskFlowMaintenanceAction(selected, now, () => false);
    if (!selectedAction) {
      continue;
    }
    const attempts = selectedAction.kind === "prune" ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let taskRead: TaskRegistryRead | undefined;
      if (selectedAction.kind !== "repair") {
        taskOwner ??= await prepareTaskRegistryReadOwner(context);
        taskRead = await prepareTaskRegistryRead(taskOwner);
        assertOwnerCurrent();
        if (!taskRead) {
          break;
        }
      }
      // Task restoration and accepted publications may have changed the selected flow.
      const read = await prepareFlows();
      if (!read?.isTaskFlowCurrent(flowId)) {
        break;
      }
      const current = read.getTaskFlowById(flowId);
      const action =
        current &&
        resolveTaskFlowMaintenanceAction(
          current,
          now,
          () => taskRead?.hasPendingTasksForFlow(flowId) ?? true,
        );
      if (!current || !action || action.kind !== selectedAction.kind) {
        break;
      }
      const assertMutationAllowed = () => {
        assertOwnerCurrent();
        read.assertOwnerCurrent();
        if (action.kind !== "repair" && (!taskRead || taskRead.hasPendingTasksForFlow(flowId))) {
          throw new Error("Task-flow maintenance has active or unsettled linked tasks.");
        }
      };
      try {
        const result = await runTaskFlowRegistryWorkerMutation(
          { flowId, admission: context.admission },
          () =>
            runOpenClawStateWorkerOperation(
              context,
              (scope) =>
                scope.execute({
                  type: "flows.maintain",
                  input: { flowId, expectedRevision: current.revision, action: action.kind, now },
                }),
              {
                assertCurrent: assertOwnerCurrent,
                createAdmission: createSqliteWorkerWriteAdmission(assertMutationAllowed, [
                  context.admission.databasePath,
                ]),
              },
            ),
          async () => {
            assertOwnerCurrent();
            const flow = await store.readFlowAsync(context, flowId);
            assertOwnerCurrent();
            return flow;
          },
        );
        assertOwnerCurrent();
        if (result === "revision_conflict") {
          continue;
        }
        if (result === "reconciled") {
          reconciled += 1;
        } else if (result === "pruned") {
          pruned += 1;
        }
      } catch {
        // The mutation owner records failures and reconciles publication; uncertain writes never replay.
        assertOwnerCurrent();
      }
      break;
    }
  }
  return { reconciled, pruned };
}
