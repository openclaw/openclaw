import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { startGatewayTaskSupervision } from "./supervised-task.gateway.js";
import {
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  inspectTaskSupervision,
} from "./supervised-task.store.js";
import type { SupervisedAttemptRunner } from "./supervised-task.worker.js";

const mocks = vi.hoisted(() => ({
  attempt: vi.fn<SupervisedAttemptRunner>(),
  prepare: vi.fn<() => Promise<void>>(),
  error: vi.fn(),
}));
vi.mock("./supervised-task.agent.js", () => ({
  prepareSupervisedAgentRuntime: mocks.prepare,
  runSupervisedAgentAttempt: mocks.attempt,
}));
const dirs = createTempDirTracker();
const handles: Array<ReturnType<typeof startGatewayTaskSupervision>> = [];
const goal = {
  objective: "Check a fixture",
  success: [{ id: "fixture", description: "Fixture verified" }],
  partial: [],
};
const policy = { deadlineAt: 60_000, maxAttempts: 3, attemptTimeoutMs: 10_000 };
const input = {
  agentId: "poc",
  model: "openai/fixture",
  runtime: "codex" as const,
  prompt: "Check fixture",
  goal,
  policy,
};
function start() {
  const handle = startGatewayTaskSupervision({
    onError: mocks.error,
    runWithContext: async (run) => run(),
  });
  handles.push(handle);
  return handle;
}
beforeEach(() => {
  // Keep module-loader scheduling real; only supervisor intervals and its clock are controlled.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(1000);
  vi.stubEnv("OPENCLAW_STATE_DIR", dirs.make("supervised-gateway-"));
  resetGatewayWorkAdmission();
  mocks.attempt.mockReset();
  mocks.prepare.mockReset().mockResolvedValue();
  mocks.error.mockReset();
});
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.stop();
  }
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetGatewayWorkAdmission();
  dirs.cleanup();
});

it("keeps an unactivated installation non-creating, then observes explicit activation", async () => {
  start();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fs.existsSync(resolveOpenClawStateSqlitePath(process.env))).toBe(false);
  heartbeatTaskSupervisor("admitter", Date.now(), 60_000);
  const task = createSupervisedTask(input, "admitter", Date.now());
  mocks.attempt.mockResolvedValue({
    kind: "succeeded",
    summary: "Checked",
    evidence: [{ criterionId: "fixture", observation: "Verified fixture" }],
  });
  await vi.advanceTimersByTimeAsync(5000);
  expect(mocks.attempt).toHaveBeenCalledTimes(1);
  expect(getSupervisedTask(task.flowId)?.phase).toBe("succeeded");
});

it("revokes the exact active source synchronously on Gateway owner stop", async () => {
  heartbeatTaskSupervisor("admitter", Date.now(), 60_000);
  const task = createSupervisedTask(input, "admitter", Date.now());
  mocks.attempt.mockImplementation(() => new Promise<never>(() => {}));
  const handle = start();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.attempt).toHaveBeenCalledTimes(1);
  const context = mocks.attempt.mock.calls[0]![1];
  expect(() => context.assertCurrent()).not.toThrow();
  handle.stop();
  expect(context.signal.aborted).toBe(true);
  expect(() => context.assertCurrent()).toThrow();
  expect(getSupervisedTask(task.flowId)).toMatchObject({
    phase: "input_required",
    endpoint: { effects: "unknown" },
  });
});

it("an old Gateway stop cannot stop a separately started successor owner", async () => {
  heartbeatTaskSupervisor("admitter", Date.now(), 60_000);
  const first = start();
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(1));
  start();
  await vi.waitFor(() => expect(mocks.prepare).toHaveBeenCalledTimes(2));
  expect(mocks.error.mock.calls).toEqual([]);
  first.stop();
  const task = createSupervisedTask(input, "admitter", Date.now());
  mocks.attempt.mockResolvedValue({
    kind: "succeeded",
    summary: "Checked",
    evidence: [{ criterionId: "fixture", observation: "Verified fixture" }],
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(getSupervisedTask(task.flowId)?.phase).toBe("succeeded");
  expect(inspectTaskSupervision(task.flowId, Date.now())?.continuation).toBe("stopped");
});

it("does not consume an attempt while restart admission is closed", async () => {
  heartbeatTaskSupervisor("admitter", Date.now(), 60_000);
  start();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  markGatewayRestartDraining();
  const task = createSupervisedTask(input, "admitter", Date.now());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.attempt).not.toHaveBeenCalled();
  expect(getSupervisedTask(task.flowId)).toMatchObject({
    phase: "ready",
    attempts: 0,
    endpoint: null,
  });
});

it("preserves ready work across suspension beyond the attempt timeout and runs after reopening", async () => {
  heartbeatTaskSupervisor("admitter", Date.now(), 60_000);
  start();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  const suspension = tryBeginGatewaySuspendAdmission(() => {});
  expect(suspension).not.toBeNull();
  const task = createSupervisedTask(input, "admitter", Date.now());
  await vi.advanceTimersByTimeAsync(15_000);
  expect(mocks.attempt).not.toHaveBeenCalled();
  expect(getSupervisedTask(task.flowId)).toMatchObject({
    phase: "ready",
    attempts: 0,
    endpoint: null,
  });
  suspension!.rollback();
  mocks.attempt.mockResolvedValue({
    kind: "succeeded",
    summary: "Checked",
    evidence: [{ criterionId: "fixture", observation: "Verified fixture" }],
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(getSupervisedTask(task.flowId)?.phase).toBe("succeeded");
});

it("does not admit a worker after its Gateway stops during runtime preparation", async () => {
  heartbeatTaskSupervisor("admitter", Date.now(), 60_000);
  let release!: () => void;
  mocks.prepare.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const handle = start();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.prepare).toHaveBeenCalledTimes(1);
  handle.stop();
  const task = createSupervisedTask(input, "admitter", Date.now());
  release();
  await vi.advanceTimersByTimeAsync(6000);
  expect(mocks.attempt).not.toHaveBeenCalled();
  expect(mocks.error).not.toHaveBeenCalled();
  expect(getSupervisedTask(task.flowId)).toMatchObject({ phase: "ready", attempts: 0 });
});
