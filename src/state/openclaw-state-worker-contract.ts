import type { TaskFlowView } from "../plugins/runtime/task-domain-types.js";
import type { TaskFlowRecord } from "../tasks/task-flow-registry.types.js";
import type { TaskRecord, TaskRegistrySummary } from "../tasks/task-registry.types.js";

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

/** Commands share one physical shared-state actor; bindings belong to commands, not open input. */
export type OpenClawStateWorkerOperations = {
  "tasks.get": { input: { taskId: string }; output: TaskRecord | undefined };
  "tasks.list": { input: { ownerKey: string }; output: TaskRecord[] };
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
