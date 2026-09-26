import { expect, it, vi } from "vitest";
import {
  listTaskRecords,
  listTasksForOwnerKey,
  listTasksForRelatedSessionKey,
  resolveTaskForLookupToken,
} from "./task-registry.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import { createTaskFixture, withTaskRegistryTempDir } from "./task-registry.test-support.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

export function registerTaskRegistrySummaryTests() {
  it("summarizes task pressure by status and runtime", async () => {
    await withTaskRegistryTempDir(async () => {
      createTaskFixture("acp", {
        runId: "run-summary-acp",
        task: "Investigate issue",
        status: "queued",
        deliveryStatus: "pending",
      });
      createTaskFixture("cron", {
        ownerKey: "",
        scopeKind: "system",
        runId: "run-summary-cron",
        task: "Daily digest",
      });
      createTaskFixture("subagent", {
        runId: "run-summary-subagent",
        task: "Write patch",
        status: "timed_out",
        deliveryStatus: "session_queued",
      });

      expect(summarizeTaskRecords(listTaskRecords())).toEqual({
        total: 3,
        active: 2,
        terminal: 1,
        failures: 1,
        byStatus: {
          queued: 1,
          running: 1,
          succeeded: 0,
          failed: 0,
          timed_out: 1,
          cancelled: 0,
          lost: 0,
        },
        byRuntime: {
          subagent: 1,
          acp: 1,
          cli: 0,
          cron: 1,
        },
      });
    });
  });
}

export function registerTaskRegistryLookupTests() {
  it("restores persisted tasks from disk on the next lookup", async () => {
    await withTaskRegistryTempDir(
      async () => {
        resetTaskRegistryForTests({ persist: false });

        const task = createTaskFixture("subagent", {
          childSessionKey: "agent:main:subagent:child",
          runId: "run-restore",
          task: "Restore me",
          deliveryStatus: "pending",
        });

        resetTaskRegistryForTests({
          persist: false,
        });

        expect(resolveTaskForLookupToken(task.taskId)).toMatchObject({
          taskId: task.taskId,
          runId: "run-restore",
          task: "Restore me",
        });
      },
      { durableStore: true },
    );
  });

  it("indexes tasks by session key for latest and list lookups", async () => {
    await withTaskRegistryTempDir(async () => {
      const nowSpy = vi.spyOn(Date, "now");
      nowSpy.mockReturnValue(1_700_000_000_000);

      const older = createTaskFixture("acp", {
        status: undefined,
        deliveryStatus: undefined,
        childSessionKey: "agent:main:subagent:child-1",
        runId: "run-session-lookup-1",
        task: "Older task",
      });
      const latest = createTaskFixture("subagent", {
        status: undefined,
        deliveryStatus: undefined,
        childSessionKey: "agent:main:subagent:child-2",
        runId: "run-session-lookup-2",
        task: "Latest task",
      });
      nowSpy.mockRestore();

      expect(listTasksForOwnerKey("agent:main:main")[0]?.taskId).toBe(latest.taskId);
      expect(listTasksForOwnerKey("agent:main:main").map((task) => task.taskId)).toEqual([
        latest.taskId,
        older.taskId,
      ]);
      expect(listTasksForRelatedSessionKey("agent:main:subagent:child-1")[0]?.taskId).toBe(
        older.taskId,
      );
    });
  });
}
