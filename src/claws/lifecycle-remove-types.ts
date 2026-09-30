import type { moveToTrash } from "../commands/cleanup-utils.js";

export type ClawTrashPath = typeof moveToTrash;

export type RemovedWorkspaceFile = {
  path: string;
  action: "deleted" | "missing" | "retainedModified" | "retainedUnowned" | "error";
  message?: string;
};
