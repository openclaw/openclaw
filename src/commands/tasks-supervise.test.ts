import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createSupervisedTask,
  findCurrentTaskSupervisor,
  getSupervisedTask,
} from "../tasks/supervised-task.store.js";
import type { SupervisedAttemptRunner } from "../tasks/supervised-task.worker.js";
import { workSupervisedTasksCommand } from "./tasks-supervise.js";

const mocks = vi.hoisted(() => ({ attempt: vi.fn<SupervisedAttemptRunner>() }));
vi.mock("../tasks/supervised-task.agent.js", () => ({
  prepareSupervisedAgentRuntime: async () => {},
  runSupervisedAgentAttempt: mocks.attempt,
}));
const dirs = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it("replaces an expired daemon owner, completes queued work, and honors explicit stop", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(1000);
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("supervised-cli-"));
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  mocks.attempt.mockResolvedValue({
    kind: "succeeded",
    summary: "Fixture checked",
    evidence: [{ criterionId: "fixture", observation: "Checked fixture" }],
  });
  let ended = false;
  const execution = workSupervisedTasksCommand(runtime).finally(() => {
    ended = true;
  });
  try {
    await vi.waitFor(() => expect(findCurrentTaskSupervisor(Date.now())).toBeDefined());
    const firstOwner = findCurrentTaskSupervisor(Date.now())!;
    const task = createSupervisedTask(
      {
        agentId: "poc",
        runtime: "codex",
        model: "openai/fixture",
        prompt: "Check fixture",
        goal: {
          objective: "Check fixture",
          success: [{ id: "fixture", description: "Checked" }],
          partial: [],
        },
        policy: { deadlineAt: 120_000, maxAttempts: 3, attemptTimeoutMs: 10_000 },
      },
      firstOwner,
      Date.now(),
    );
    // A sleeping host loses its lease without getting intermediate heartbeat ticks.
    vi.setSystemTime(21_000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(
      () => {
        const successor = findCurrentTaskSupervisor(Date.now());
        expect(successor).toBeDefined();
        expect(successor).not.toBe(firstOwner);
      },
      { timeout: 3000 },
    );
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSupervisedTask(task.flowId)?.phase).toBe("succeeded");
    expect(mocks.attempt).toHaveBeenCalledTimes(1);
  } finally {
    process.emit("SIGTERM", "SIGTERM");
    await execution;
  }
  expect(findCurrentTaskSupervisor(Date.now())).toBeUndefined();
  await vi.advanceTimersByTimeAsync(5000);
  expect(findCurrentTaskSupervisor(Date.now())).toBeUndefined();
});
