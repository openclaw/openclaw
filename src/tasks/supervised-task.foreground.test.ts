import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { runSupervisedForegroundAdmission } from "./supervised-task.foreground.js";
import { getSupervisedTask, listSupervisedTasks } from "./supervised-task.store.js";
import type { SupervisedAttemptRunner } from "./supervised-task.worker.js";

const mocks = vi.hoisted(() => ({
  classify: vi.fn(),
  prepare: vi.fn(),
  attempt: vi.fn<SupervisedAttemptRunner>(),
}));
vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion: mocks.classify }));
vi.mock("../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "codex", runtimeSource: "model" }),
}));
vi.mock("./supervised-task.agent.js", () => ({
  prepareSupervisedAgentRuntime: mocks.prepare,
  runSupervisedAgentAttempt: mocks.attempt,
}));
const dirs = createTempDirTracker();
beforeEach(() => {
  mocks.classify
    .mockReset()
    .mockResolvedValue({ text: '{"kind":"task"}', owner: { kind: "harness", id: "codex" } });
  mocks.prepare.mockReset().mockResolvedValue(undefined);
  mocks.attempt.mockReset().mockResolvedValue({
    kind: "input_required",
    reason: "Observed an acceptance question",
    question: "Which fixture behavior is intended?",
  });
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

async function fixture() {
  const root = dirs.make("supervision-foreground-");
  const workspace = `${root}/input`;
  await fs.mkdir(workspace);
  const policyFile = `${root}/policy.json`;
  await fs.writeFile(
    policyFile,
    JSON.stringify({
      version: 1,
      scope: "Repair source",
      goal: {
        objective: "Repair source",
        success: [{ id: "correct", description: "Accepted output" }],
        partial: [],
      },
      workflow: {
        version: 1,
        workspace,
        profiles: [],
        acceptance: [{ kind: "operator", criterionId: "correct" }],
      },
      maxAttempts: 3,
      attemptTimeoutMs: 10000,
      episodeTimeoutMs: 60000,
    }),
    { mode: 0o600 },
  );
  const config: OpenClawConfig = {
    agents: { entries: { poc: { taskSupervision: { enabled: true, policyFile } } } },
  };
  return {
    config,
    source: {
      agentId: "poc",
      sessionId: "source",
      sessionKey: "agent:poc:main",
      namespace: "local" as const,
      inputId: "run",
      ownerScope: "local-source",
    },
    message: "Repair the fixture",
    model: "openai/fixture",
    ownerAuthorized: true,
    internal: false,
    assertCurrent: () => {},
    onError: vi.fn(),
    onHandoff: vi.fn(async () => {}),
    options: { path: `${root}/state.sqlite` },
  };
}

it("retains real foreground custody until an endpoint and replays without another attempt", async () => {
  const f = await fixture();
  let handoff = false;
  f.onHandoff.mockImplementation(async () => {
    expect(mocks.attempt).not.toHaveBeenCalled();
    handoff = true;
  });
  mocks.attempt.mockImplementation(async (task, context) => {
    expect(handoff).toBe(true);
    context.assertCurrent();
    expect(task.phase).toBe("running");
    return { kind: "input_required", reason: "Need input", question: "Specify expected output" };
  });
  const result = await runSupervisedForegroundAdmission(f);
  expect(result.task).toMatchObject({ phase: "input_required", attempts: 1 });
  const original = getSupervisedTask(result.task!.flowId, f.options);
  f.onHandoff.mockResolvedValue(undefined);
  expect((await runSupervisedForegroundAdmission(f)).task).toEqual(original);
  expect(mocks.attempt).toHaveBeenCalledTimes(1);
  expect(mocks.classify).toHaveBeenCalledTimes(1);
});

it("replaces a stopped owner without exiting while accepted work remains queued", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["Date"] });
  f.onHandoff.mockImplementation(async () => {
    vi.setSystemTime(Date.now() + 20_000);
  });
  const result = await runSupervisedForegroundAdmission(f);
  expect(result.task?.phase).toBe("input_required");
  expect(mocks.prepare).toHaveBeenCalledTimes(2);
  expect(mocks.attempt).toHaveBeenCalledTimes(1);
});

it("does not start a worker after cancellation during runtime preparation", async () => {
  const f = await fixture();
  const controller = new AbortController();
  mocks.prepare.mockImplementation(async () => {
    controller.abort(new Error("Stopped during preparation"));
  });
  await expect(
    runSupervisedForegroundAdmission({ ...f, signal: controller.signal }),
  ).rejects.toThrow("Stopped during preparation");
  expect(listSupervisedTasks(f.options)).toEqual([]);
  expect(mocks.attempt).not.toHaveBeenCalled();
  expect(f.onHandoff).not.toHaveBeenCalled();
});

it("returns ordinary conversation without preparing any continuation worker", async () => {
  const f = await fixture();
  mocks.classify.mockResolvedValue({
    text: '{"kind":"ordinary"}',
    owner: { kind: "harness", id: "codex" },
  });
  expect(await runSupervisedForegroundAdmission(f)).toEqual({ result: { kind: "ordinary" } });
  expect(mocks.prepare).not.toHaveBeenCalled();
  expect(mocks.attempt).not.toHaveBeenCalled();
});
