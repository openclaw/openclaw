import type { MinionJobStatus } from "../minions/types.js";
import type { TaskStatus } from "./task-registry.types.js";

/**
 * Bidirectional mapping between TaskStatus (public contract) and
 * MinionJobStatus (internal substrate). This module is the single source of
 * truth for status translation. If you change it, update the behavior-
 * preservation test matrix in task-registry.facade-preservation.test.ts.
 *
 * TaskStatus values not listed (attached, resumed) are new in the minions
 * era and have no legacy TaskStatus equivalent.
 */

export function taskStatusToMinionStatus(status: TaskStatus): MinionJobStatus {
  switch (status) {
    case "queued":
      return "waiting";
    case "running":
      return "active";
    case "succeeded":
      return "completed";
    case "failed":
      return "failed";
    case "timed_out":
      return "dead";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "dead";
  }
}

export function minionStatusToTaskStatus(status: MinionJobStatus): TaskStatus {
  switch (status) {
    case "waiting":
      return "queued";
    case "active":
      return "running";
    case "completed":
      return "succeeded";
    case "failed":
      return "failed";
    case "delayed":
      return "queued";
    case "dead":
      return "lost";
    case "cancelled":
      return "cancelled";
    case "waiting-children":
      return "running";
    case "paused":
      return "queued";
    case "attached":
      return "running";
    case "cancelling":
      return "running";
  }
}

export const TASK_TO_MINION_STATUS_MAP: ReadonlyMap<TaskStatus, MinionJobStatus> = new Map([
  ["queued", "waiting"],
  ["running", "active"],
  ["succeeded", "completed"],
  ["failed", "failed"],
  ["timed_out", "dead"],
  ["cancelled", "cancelled"],
  ["lost", "dead"],
]);
