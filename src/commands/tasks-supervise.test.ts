import { writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  createSupervisedTask,
  claimSupervisedTask,
  findCurrentTaskSupervisor,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
  settleSupervisedDecision,
} from "../tasks/supervised-task.store.js";
import type { SupervisedAttemptRunner } from "../tasks/supervised-task.worker.js";
import { startSupervisedTaskCommand, workSupervisedTasksCommand } from "./tasks-supervise.js";

const mocks = vi.hoisted(() => ({ attempt: vi.fn<SupervisedAttemptRunner>() }));
vi.mock("../tasks/supervised-task.agent.js", () => ({
  prepareSupervisedAgentRuntime: async () => {},
  runSupervisedAgentAttempt: mocks.attempt,
}));
const dirs = createTempDirTracker();
afterEach(() => {
  mocks.attempt.mockReset();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  dirs.cleanup();
});

it.each(["ready", "waiting"] as const)(
  "rejects a duplicate foreground submission without disturbing the existing %s task",
  async (phase) => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1000);
    const directory = dirs.make("supervised-duplicate-");
    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    heartbeatTaskSupervisor("existing-owner", 1000, 10_000);
    const definition = {
      flowId: "existing-task",
      agentId: "poc",
      runtime: "codex" as const,
      model: "openai/fixture",
      prompt: "Check fixture",
      goal: {
        objective: "Check fixture",
        success: [{ id: "fixture", description: "Checked" }],
        partial: [],
      },
      policy: { deadlineAt: 120_000, maxAttempts: 3, attemptTimeoutMs: 10_000 },
    };
    createSupervisedTask(definition, "existing-owner", Date.now());
    if (phase === "waiting") {
      const claimed = claimSupervisedTask(definition.flowId, "existing-owner", Date.now())!;
      const dispatched = reserveSupervisedDispatch(claimed, Date.now());
      settleSupervisedDecision(
        dispatched,
        { kind: "wait", next: "Check later", wakeAt: 2000 },
        Date.now(),
      );
      vi.setSystemTime(2000);
    }
    const before = getSupervisedTask(definition.flowId);
    const filename = path.join(directory, "duplicate.json");
    await writeFile(filename, JSON.stringify(definition));
    await expect(
      startSupervisedTaskCommand(filename, true, { log: vi.fn(), error: vi.fn(), exit: vi.fn() }),
    ).rejects.toThrow("Supervised TaskFlow already exists");
    expect(getSupervisedTask(definition.flowId)).toEqual(before);
    expect(mocks.attempt).not.toHaveBeenCalled();
    expect(findCurrentTaskSupervisor(Date.now())).toBe("existing-owner");
  },
);

it("opens foreground dispatch only after admitting a new task", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(1000);
  const directory = dirs.make("supervised-new-");
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  const filename = path.join(directory, "new.json");
  await writeFile(
    filename,
    JSON.stringify({
      flowId: "new-task",
      agentId: "poc",
      runtime: "codex",
      model: "openai/fixture",
      authProfileId: "openai:work",
      prompt: "Check fixture",
      goal: {
        objective: "Check fixture",
        success: [{ id: "fixture", description: "Checked" }],
        partial: [],
      },
      policy: { deadlineAt: 120_000, maxAttempts: 3, attemptTimeoutMs: 10_000 },
    }),
  );
  mocks.attempt.mockImplementation(async (task) => {
    expect(task.authProfileId).toBe("openai:work");
    expect(getSupervisedTask(task.flowId)?.attempt?.id).toBe(task.attempt?.id);
    return {
      kind: "succeeded",
      summary: "Checked",
      evidence: [{ criterionId: "fixture", observation: "Checked" }],
    };
  });
  const execution = startSupervisedTaskCommand(filename, true, {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  });
  await vi.waitFor(() => expect(getSupervisedTask("new-task")).toBeDefined());
  await vi.advanceTimersByTimeAsync(1000);
  await execution;
  expect(getSupervisedTask("new-task")?.phase).toBe("succeeded");
  expect(mocks.attempt).toHaveBeenCalledTimes(1);
  expect(findCurrentTaskSupervisor(Date.now())).toBeUndefined();
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
