import type {
  ExecutionOwnerBinding,
  ExecutionOwnerBindingResult,
} from "../audit/execution-owner-binding.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import type { TaskFlowView } from "../plugins/runtime/task-domain-types.js";
import type {
  TaskFlowMaintenanceInput,
  TaskFlowMaintenanceOutcome,
} from "./task-flow-maintenance-policy.js";
import type {
  ManagedTaskInFlowInput,
  ManagedTaskInFlowReceipt,
} from "./task-flow-managed-run-task.kernel.js";
import type {
  TaskFlowRegistryStoreSnapshot,
  TaskFlowRegistryUpdate,
  TaskFlowRegistryUpdateResult,
} from "./task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskInitialWorkerOperations } from "./task-initial-worker.types.js";
import type { TaskAgentEventWorkerOperations } from "./task-registry-agent-event.operation.js";
import type {
  TaskRegistryRestoreResult,
  TaskMirroredFlowSyncOutcome,
} from "./task-registry-restore.worker.js";
import type { TaskRegistryStatusSnapshot } from "./task-registry.store.status.js";
import type { TaskLiveFlowSyncOutcome } from "./task-registry.store.types.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

type TaskLookupRecords = {
  direct?: TaskRecord;
  byRun?: TaskRecord;
  related: TaskRecord[];
};

type TaskFlowRead = {
  flow: TaskFlowRecord;
  tasks: TaskRecord[];
};

type TaskFlowReadQuery = {
  ownerKey: string;
  lookup: "id" | "latest" | "resolve";
  token?: string;
};

export type TaskRegistryWorkerOperations = TaskInitialWorkerOperations &
  TaskAgentEventWorkerOperations & {
    "tasks.bindExecution": {
      input: { taskId: string; binding: ExecutionOwnerBinding };
      output: ExecutionOwnerBindingResult;
    };
    "flows.bindExecution": {
      input: { flowId: string; binding: ExecutionOwnerBinding };
      output: ExecutionOwnerBindingResult;
    };
    "tasks.restore": { input: undefined; output: TaskRegistryRestoreResult };
    "flows.syncMirroredTask": {
      input: { taskId: string; expectedParentFlowId?: string };
      output: TaskMirroredFlowSyncOutcome;
    };
    "flows.snapshot": { input: undefined; output: TaskFlowRegistryStoreSnapshot };
    "flows.syncLiveMirroredTask": {
      input: { taskId: string; flowId: string };
      output: TaskLiveFlowSyncOutcome;
    };
    "tasks.statusSummary": {
      input: { now: number; preserveSourceArtifacts: boolean };
      output: TaskRegistryStatusSnapshot | undefined;
    };
    "flows.runTask": { input: ManagedTaskInFlowInput; output: ManagedTaskInFlowReceipt };
    "flows.createManaged": {
      input: { flow: TaskFlowRecord };
      output: TaskFlowRecord;
    };
    "flows.updateManaged": {
      input: TaskFlowRegistryUpdate & {
        ownerKey: string;
      };
      output:
        | TaskFlowRegistryUpdateResult
        | { applied: false; reason: "not_managed"; current: TaskFlowRecord }
        | { applied: false; reason: "persist_failed"; current?: TaskFlowRecord };
    };
    "flows.current": { input: { flowId: string }; output: TaskFlowRecord | undefined };
    "flows.maintain": { input: TaskFlowMaintenanceInput; output: TaskFlowMaintenanceOutcome };
    "tasks.get": { input: { taskId: string }; output: TaskRecord | undefined };
    "tasks.findByRunId": { input: { runId: string }; output: TaskRecord | undefined };
    "tasks.list": { input: { ownerKey: string }; output: TaskRecord[] };
    "tasks.ownerRecords": { input: { ownerKey: string }; output: TaskRecord[] };
    "tasks.resolve": {
      input: { ownerKey: string; token: string };
      output: TaskLookupRecords;
    };
    "flows.list": { input: { ownerKey: string }; output: TaskFlowRecord[] };
    "flows.views": { input: { ownerKey: string }; output: TaskFlowView[] };
    "flows.summary": {
      input: { ownerKey: string; flowId: string };
      output: TaskRegistrySummary | undefined;
    };
    "flows.read": {
      input: TaskFlowReadQuery;
      output: TaskFlowRecord | undefined;
    };
    "flows.detail": {
      input: TaskFlowReadQuery;
      output: TaskFlowRead | undefined;
    };
  };

export function isTaskRegistryWorkerCommand(command: {
  type: string;
  input: unknown;
}): command is SqliteWorkerCommand<TaskRegistryWorkerOperations> {
  switch (command.type) {
    case "tasks.bindRunOwner":
    case "tasks.transitionRunRow":
    case "tasks.updateNotificationDelivery":
    case "tasks.acknowledgeStateChange":
    case "tasks.bindExecution":
    case "flows.bindExecution":
    case "tasks.observeAgentEvent":
    case "tasks.createRecord":
    case "tasks.finalizeActive":
    case "tasks.settleUnstarted":
    case "flows.createForTask":
    case "tasks.linkInitialFlow":
    case "flows.deleteUnlinkedForTask":
    case "flows.finalizeTaskCancellation":
    case "tasks.restore":
    case "flows.syncMirroredTask":
    case "flows.snapshot":
    case "flows.syncLiveMirroredTask":
    case "tasks.statusSummary":
    case "flows.runTask":
    case "flows.createManaged":
    case "flows.updateManaged":
    case "flows.current":
    case "flows.maintain":
    case "tasks.get":
    case "tasks.findByRunId":
    case "tasks.list":
    case "tasks.ownerRecords":
    case "tasks.resolve":
    case "flows.list":
    case "flows.views":
    case "flows.summary":
    case "flows.read":
    case "flows.detail":
      return true;
    default:
      return false;
  }
}
