import type {
  CreatedDetachedTaskRun,
  DetachedTaskTerminalState,
} from "./detached-task-runtime-contract.js";
import type {
  InitialTaskFlowCreateInput,
  InitialTaskFlowCreateResult,
  InitialTaskFlowDeleteInput,
  InitialTaskFlowDeleteResult,
  InitialTaskFlowLinkInput,
  InitialTaskFlowLinkResult,
  InitialTaskManagedCancellationResult,
} from "./task-initial-flow.kernel.js";
import type {
  TaskStateNotificationAcknowledgement,
  TaskNotificationDeliveryUpdate,
} from "./task-notification.operation.js";
import type { TaskCreateInput, TaskCreateResult } from "./task-registry-create.kernel.js";
import type {
  TaskRecordTransitionReceipt,
  TaskWorkerTransitionInput,
} from "./task-registry-transition.kernel.js";
import type {
  TaskExecutionOwner,
  TaskPersistenceReceipt,
  TaskRuntime,
} from "./task-registry.types.js";

export type TaskInitialWorkerOperations = {
  "tasks.transitionRunRow": {
    input: Extract<TaskWorkerTransitionInput, { kind: "state" | "delivery" }>;
    output: TaskRecordTransitionReceipt | null;
  };
  "tasks.bindRunOwner": {
    input: {
      taskId: string;
      expectedTask: TaskPersistenceReceipt;
      params: { runId: string; executionOwner?: TaskExecutionOwner };
      now: number;
    };
    output: TaskRecordTransitionReceipt | null;
  };
  "tasks.updateNotificationDelivery": {
    input: TaskNotificationDeliveryUpdate;
    output: TaskRecordTransitionReceipt | null;
  };
  "tasks.acknowledgeStateChange": {
    input: TaskStateNotificationAcknowledgement;
    output: TaskRecordTransitionReceipt | null;
  };
  "tasks.createRecord": { input: TaskCreateInput; output: TaskCreateResult };
  "tasks.finalizeActive": {
    input: {
      taskId: string;
      expectedTask: TaskPersistenceReceipt;
      params: {
        runId: string;
        runtime: TaskRuntime;
        sessionKey?: string;
      } & Parameters<CreatedDetachedTaskRun["finalizeActive"]>[0];
      now: number;
    };
    output: TaskRecordTransitionReceipt | null;
  };
  "tasks.settleUnstarted": {
    input: {
      taskId: string;
      expectedTask: TaskPersistenceReceipt;
      terminal: Pick<
        DetachedTaskTerminalState,
        "status" | "endedAt" | "error" | "terminalSummary" | "suppressDelivery" | "lastEventAt"
      >;
      now: number;
    };
    output: TaskRecordTransitionReceipt | null;
  };
  "flows.createForTask": { input: InitialTaskFlowCreateInput; output: InitialTaskFlowCreateResult };
  "tasks.linkInitialFlow": { input: InitialTaskFlowLinkInput; output: InitialTaskFlowLinkResult };
  "flows.deleteUnlinkedForTask": {
    input: InitialTaskFlowDeleteInput;
    output: InitialTaskFlowDeleteResult;
  };
  "flows.finalizeTaskCancellation": {
    input: { taskId: string; flowId: string; now: number };
    output: InitialTaskManagedCancellationResult;
  };
};

export type TaskInitialWorkerCommand = {
  [Key in keyof TaskInitialWorkerOperations]: {
    type: Key;
    input: TaskInitialWorkerOperations[Key]["input"];
  };
}[keyof TaskInitialWorkerOperations];
