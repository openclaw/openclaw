import type { TaskRecord } from "./task-registry.types.js";

export type TaskFlowSyncTask = Pick<
  TaskRecord,
  | "parentFlowId"
  | "status"
  | "terminalOutcome"
  | "notifyPolicy"
  | "label"
  | "task"
  | "lastEventAt"
  | "endedAt"
  | "taskId"
  | "terminalSummary"
  | "progressSummary"
>;
