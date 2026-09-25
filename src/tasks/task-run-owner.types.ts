import type { Result } from "@openclaw/normalization-core/result";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRunOwner = {
  /** Live creation-receipt custody, including its physical database and exact task generation. */
  readCurrent?: () => Readonly<TaskRecord>;
  /** Start an admitted execution without replacing the logical task or its audit binding. */
  resumeExecution?: (assertCurrent: () => void) => Promise<void>;
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskRunOwnerBinding = { owner: TaskRunOwner; release: () => void };
