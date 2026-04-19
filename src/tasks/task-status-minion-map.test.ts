import { describe, expect, it } from "vitest";
import {
  TASK_TO_MINION_STATUS_MAP,
  minionStatusToTaskStatus,
  taskStatusToMinionStatus,
} from "./task-status-minion-map.js";
import type { TaskStatus } from "./task-registry.types.js";
import type { MinionJobStatus } from "../minions/types.js";

describe("taskStatusToMinionStatus", () => {
  it.each<[TaskStatus, MinionJobStatus]>([
    ["queued", "waiting"],
    ["running", "active"],
    ["succeeded", "completed"],
    ["failed", "failed"],
    ["timed_out", "dead"],
    ["cancelled", "cancelled"],
    ["lost", "dead"],
  ])("maps %s → %s", (taskStatus, expected) => {
    expect(taskStatusToMinionStatus(taskStatus)).toBe(expected);
  });
});

describe("minionStatusToTaskStatus", () => {
  it.each<[MinionJobStatus, TaskStatus]>([
    ["waiting", "queued"],
    ["active", "running"],
    ["completed", "succeeded"],
    ["failed", "failed"],
    ["delayed", "queued"],
    ["dead", "lost"],
    ["cancelled", "cancelled"],
    ["waiting-children", "running"],
    ["paused", "queued"],
    ["attached", "running"],
    ["cancelling", "running"],
  ])("maps %s → %s", (minionStatus, expected) => {
    expect(minionStatusToTaskStatus(minionStatus)).toBe(expected);
  });
});

describe("TASK_TO_MINION_STATUS_MAP", () => {
  it("covers all 7 TaskStatus values", () => {
    const taskStatuses: TaskStatus[] = [
      "queued",
      "running",
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "lost",
    ];
    for (const status of taskStatuses) {
      expect(TASK_TO_MINION_STATUS_MAP.has(status)).toBe(true);
    }
    expect(TASK_TO_MINION_STATUS_MAP.size).toBe(7);
  });

  it("round-trips through both functions for terminal statuses", () => {
    const terminals: TaskStatus[] = ["succeeded", "failed", "cancelled"];
    for (const ts of terminals) {
      const ms = taskStatusToMinionStatus(ts);
      const back = minionStatusToTaskStatus(ms);
      expect(back).toBe(ts);
    }
  });
});
