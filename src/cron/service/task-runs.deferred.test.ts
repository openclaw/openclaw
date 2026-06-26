import { describe, expect, it, vi } from "vitest";
import { tryFinishCronTaskRun } from "./task-runs.js";

const taskRuntime = vi.hoisted(() => ({
  completeTaskRunByRunId: vi.fn(),
  createRunningTaskRun: vi.fn(),
  failTaskRunByRunId: vi.fn(),
}));

vi.mock("../../tasks/detached-task-runtime.js", () => taskRuntime);

describe("tryFinishCronTaskRun deferred settlement", () => {
  it("settles deferred cron task rows so they do not remain running", () => {
    const warn = vi.fn();

    tryFinishCronTaskRun({ deps: { log: { warn } } } as never, {
      taskRunId: "cron:nightly:123",
      status: "deferred",
      endedAt: 456,
      summary: "waiting for descendant tasks",
    });

    expect(taskRuntime.completeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "cron:nightly:123",
      runtime: "cron",
      endedAt: 456,
      lastEventAt: 456,
      progressSummary: null,
      terminalSummary: "waiting for descendant tasks",
    });
    expect(taskRuntime.failTaskRunByRunId).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
