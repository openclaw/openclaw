import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createRunningTaskRun } from "./detached-task-runtime.js";
import {
  evaluateTaskExecutionGate,
  listTaskExecutionReceipts,
  recordTaskExecutionReceipt,
} from "./task-execution-receipts.js";
import { resetTaskRegistryForTests } from "./task-runtime.test-helpers.js";

afterEach(() => {
  resetTaskRegistryForTests({ persist: false });
  closeOpenClawStateDatabaseForTest();
});

describe("task execution receipts", () => {
  it("appends monotonic receipts and redacts tool failures", async () => {
    await withOpenClawTestState({ label: "task-receipts" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const task = createRunningTaskRun({
        runtime: "subagent",
        requesterSessionKey: "agent:main:test",
        runId: "codex-thread:worker",
        task: "persistent worker",
      });
      expect(task).not.toBeNull();

      const first = recordTaskExecutionReceipt({
        taskId: task!.taskId,
        kind: "heartbeat",
        status: "ok",
        recordedAt: 1_000,
      });
      const second = recordTaskExecutionReceipt({
        taskId: task!.taskId,
        kind: "tool_call",
        status: "error",
        recordedAt: 1_001,
        summary: "Authorization: Bearer top-secret-token-value-1234567890",
        detail: { error: "token=detail-secret-value-1234567890" },
      });

      expect([first.sequence, second.sequence]).toEqual([1, 2]);
      expect(listTaskExecutionReceipts(task!.taskId)).toEqual([
        first,
        expect.objectContaining({
          sequence: 2,
          kind: "tool_call",
          status: "error",
          summary: expect.not.stringContaining("top-secret-token"),
          detail: { error: expect.not.stringContaining("detail-secret-value") },
        }),
      ]);
    });
  });

  it("fails closed until code, build, delivery, canary, and fresh health evidence exists", async () => {
    await withOpenClawTestState({ label: "task-receipt-gates" }, async () => {
      resetTaskRegistryForTests({ persist: false });
      const task = createRunningTaskRun({
        runtime: "subagent",
        requesterSessionKey: "agent:main:test",
        runId: "codex-thread:gated-worker",
        task: "gated worker",
      })!;
      const append = (
        kind: Parameters<typeof recordTaskExecutionReceipt>[0]["kind"],
        detail?: Record<string, unknown>,
      ) =>
        recordTaskExecutionReceipt({
          taskId: task.taskId,
          kind,
          status: "ok",
          recordedAt: 10_000,
          detail,
        });

      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "green", now: 10_000 }).ok,
      ).toBe(false);
      append("heartbeat");
      append("relay_health");
      append("connector_health");
      append("branch");
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "running_code", now: 10_000 }),
      ).toEqual(expect.objectContaining({ ok: false, missing: ["readable_diff"] }));
      append("diff", { readable: true });
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "running_code", now: 10_000 }),
      ).toEqual({ ok: true, missing: [] });
      append("commit");
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "built", now: 10_000 }),
      ).toEqual(expect.objectContaining({ ok: false, missing: ["tests"] }));
      append("tests");
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "built", now: 10_000 }),
      ).toEqual({ ok: true, missing: [] });
      append("pr");
      append("deploy");
      append("canary");
      append("readback");
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "green", now: 10_000 }),
      ).toEqual({
        ok: true,
        missing: [],
      });
      recordTaskExecutionReceipt({
        taskId: task.taskId,
        kind: "relay_health",
        status: "error",
        recordedAt: 10_001,
      });
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "green", now: 10_001 }),
      ).toEqual(
        expect.objectContaining({ ok: false, missing: expect.arrayContaining(["relay_health"]) }),
      );
      append("relay_health");
      expect(
        evaluateTaskExecutionGate({ taskId: task.taskId, gate: "green", now: 10_001 }),
      ).toEqual({ ok: true, missing: [] });
    });
  });
});
