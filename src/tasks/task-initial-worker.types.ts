import type { DetachedTaskTerminalState } from "./detached-task-runtime-contract.js";
import type {
  InitialTaskFlowCreateInput,
  InitialTaskFlowCreateResult,
  InitialTaskFlowDeleteInput,
  InitialTaskFlowDeleteResult,
  InitialTaskFlowLinkInput,
  InitialTaskFlowLinkResult,
  InitialTaskManagedCancellationResult,
} from "./task-initial-flow.kernel.js";
import type { TaskCreateInput, TaskCreateResult } from "./task-registry-create.kernel.js";
import type { TaskRecordTransitionReceipt } from "./task-registry-transition.kernel.js";
import type { TaskPersistenceReceipt } from "./task-registry.types.js";

export type TaskInitialWorkerOperations = {
  "tasks.createRecord": { input: TaskCreateInput; output: TaskCreateResult };
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
