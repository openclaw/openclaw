import type { Result } from "@openclaw/normalization-core/result";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskRunOwner = {
  task: Readonly<
    Pick<TaskRecord, "taskId" | "runtime" | "ownerKey" | "scopeKind" | "runId" | "childSessionKey">
  >;
  cancel: (reason: string) => Promise<Result<TaskRecord, string>>;
};

export type TaskRunOwnerBinding = { owner: TaskRunOwner; release: () => void };
