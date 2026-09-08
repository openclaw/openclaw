import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  assertSupervisedAttemptCurrent,
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  failSupervisedAttempt,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  inspectTaskSupervision,
  reconcileSupervisedTasks,
  reserveSupervisedDispatch,
  resumeSupervisedTask,
  settleSupervisedDecision,
  stopTaskSupervisor,
} from "./supervised-task.store.js";
import type { SupervisedTask } from "./supervised-task.types.js";
import { startSupervisedTaskWorker } from "./supervised-task.worker.js";

const tempDirs = createTempDirTracker();
const workers: Array<ReturnType<typeof startSupervisedTaskWorker>> = [];
const goal = {
  objective: "Prepare and check a local artifact",
  success: [
    { id: "artifact", description: "Artifact exists with the requested content" },
    { id: "checked", description: "Artifact content was checked" },
  ],
  partial: ["artifact"],
};
const policy = { deadlineAt: 60_000, maxAttempts: 5, attemptTimeoutMs: 10_000 };
function fixture() {
  const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-supervised-") } };
  heartbeatTaskSupervisor("owner-a", 1000, 10_000, options);
  const task = createSupervisedTask(
    {
      agentId: "poc",
      model: "openai/test-model",
      runtime: "codex",
      prompt: "Prepare the requested artifact",
      goal,
      policy,
    },
    "owner-a",
    1000,
    options,
  );
  const claim = (now = 1000) => {
    const claimed = claimSupervisedTask(task.flowId, "owner-a", now, options);
    expect(claimed?.phase).toBe("running");
    return claimed!;
  };
  return { task, options, claim };
}
function complete(task: SupervisedTask) {
  return {
    kind: "succeeded" as const,
    summary: "Artifact checked",
    evidence: task.goal!.success.map((entry) => ({
      criterionId: entry.id,
      observation: `Observed ${entry.id}`,
    })),
  };
}

afterEach(() => {
  for (const worker of workers.splice(0)) {
    worker.stop();
  }
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("supervised TaskFlow custody", () => {
  it("keeps inspection non-creating and refuses admission without a supervisor", () => {
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("supervised-unarmed-") } };
    expect(inspectTaskSupervision("missing", 1000, options)).toBeUndefined();
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(options.env))).toBe(false);
    expect(() => cancelSupervisedTask("missing", 1000, options)).toThrow("Unknown supervised task");
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(options.env))).toBe(false);
    expect(() =>
      createSupervisedTask(
        { agentId: "poc", model: "openai/test", runtime: "codex", prompt: "Do work", goal, policy },
        "missing",
        1000,
        options,
      ),
    ).toThrow("No current supervisor");
    const { db } = openOpenClawStateDatabase(options);
    expect(
      db.prepare("SELECT name FROM sqlite_schema WHERE name = 'task_flow_episodes'").get(),
    ).toBeUndefined();
  });

  it("persists a continuation before releasing an attempt and survives reopen", () => {
    const { task, claim, options } = fixture();
    const attempt = reserveSupervisedDispatch(claim(), 1000, options);
    const next = settleSupervisedDecision(
      attempt,
      { kind: "continue", next: "Check the existing artifact, do not recreate it" },
      1001,
      options,
    );
    expect(next).toMatchObject({ phase: "ready", attempt: null, attempts: 1 });
    closeOpenClawStateDatabaseForTest();
    expect(getSupervisedTask(task.flowId, options)).toEqual(next);
    const second = reserveSupervisedDispatch(claim(1002), 1002, options);
    const terminal = settleSupervisedDecision(second, complete(task), 1003, options);
    expect(terminal.endpoint).toMatchObject({
      kind: "succeeded",
      acceptedBy: "model",
      effects: "attempt_completed",
    });
    expect(() =>
      settleSupervisedDecision(attempt, { kind: "failed", reason: "late" }, 1004, options),
    ).toThrow("no longer owns");
    expect(getSupervisedTask(task.flowId, options)).toEqual(terminal);
  });

  it("requires accepted criteria and prohibits silent goal replacement", () => {
    const { task, claim, options } = fixture();
    const attempt = reserveSupervisedDispatch(claim(), 1000, options);
    expect(() =>
      settleSupervisedDecision(
        attempt,
        { kind: "define_goal", goal: { ...goal, success: goal.success.slice(0, 1) } },
        1001,
        options,
      ),
    ).toThrow("cannot be replaced");
    expect(() =>
      settleSupervisedDecision(
        attempt,
        {
          kind: "succeeded",
          summary: "Done",
          evidence: [{ criterionId: "artifact", observation: "Created" }],
        },
        1001,
        options,
      ),
    ).toThrow("Completion must provide evidence");
    expect(getSupervisedTask(task.flowId, options)?.phase).toBe("running");
    expect(
      settleSupervisedDecision(
        attempt,
        {
          kind: "partial",
          summary: "Artifact created but not checked",
          evidence: [{ criterionId: "artifact", observation: "Created" }],
        },
        1001,
        options,
      ).phase,
    ).toBe("partial");
  });

  it("supervises goal inference and cannot execute before a structured goal exists", () => {
    const { options } = fixture();
    const task = createSupervisedTask(
      {
        agentId: "poc",
        model: "claude-cli/test",
        runtime: "claude-cli",
        prompt: "Prepare a report",
        policy,
      },
      "owner-a",
      1000,
      options,
    );
    const attempt = reserveSupervisedDispatch(
      claimSupervisedTask(task.flowId, "owner-a", 1000, options)!,
      1000,
      options,
    );
    expect(() =>
      settleSupervisedDecision(attempt, { kind: "continue", next: "Do something" }, 1001, options),
    ).toThrow("Define a structured goal");
    expect(() =>
      settleSupervisedDecision(attempt, { kind: "define_goal", goal }, 1001, options),
    ).toThrow("cannot grant partial-success permission");
    const inferredGoal = { ...goal, partial: [] };
    expect(
      settleSupervisedDecision(attempt, { kind: "define_goal", goal: inferredGoal }, 1001, options),
    ).toMatchObject({ goal: inferredGoal, goalSource: "model", phase: "ready" });
  });

  it("resumes an input endpoint as exactly one new episode, preserving history", () => {
    const { task, claim, options } = fixture();
    const attempt = reserveSupervisedDispatch(claim(), 1000, options);
    const endpoint = settleSupervisedDecision(
      attempt,
      { kind: "input_required", reason: "Missing artifact name", question: "Which artifact?" },
      1001,
      options,
    );
    const resumed = resumeSupervisedTask(
      task.flowId,
      1,
      "Use report.txt",
      policy,
      "owner-a",
      1002,
      options,
    );
    expect(resumed).toMatchObject({
      episode: 2,
      attempts: 0,
      phase: "ready",
      next: "Use report.txt",
    });
    expect(getSupervisedTask(task.flowId, options, 1)).toEqual(endpoint);
    expect(() =>
      resumeSupervisedTask(task.flowId, 1, "Duplicate response", policy, "owner-a", 1003, options),
    ).toThrow("latest input endpoint");
  });

  it.each([false, true])(
    "recovers dead owner without replaying reserved dispatch=%s",
    (dispatched) => {
      const { task, claim, options } = fixture();
      const old = dispatched ? reserveSupervisedDispatch(claim(), 1000, options) : claim();
      heartbeatTaskSupervisor("owner-b", 11_001, 10_000, options);
      reconcileSupervisedTasks(11_001, options);
      expect(() => heartbeatTaskSupervisor("owner-a", 11_001, 10_000, options)).toThrow(
        "cannot renew",
      );
      expect(() => assertSupervisedAttemptCurrent(old, 11_001, options)).toThrow("no longer owns");
      if (dispatched) {
        expect(getSupervisedTask(task.flowId, options)).toMatchObject({
          phase: "input_required",
          endpoint: { effects: "unknown" },
        });
        expect(claimSupervisedTask(task.flowId, "owner-b", 11_001, options)).toBeUndefined();
      } else {
        const next = claimSupervisedTask(task.flowId, "owner-b", 11_001, options);
        expect(next?.attempt?.id).not.toBe(old.attempt!.id);
        expect(next?.attempts).toBe(2);
        expect(failSupervisedAttempt(old, "late failure", 11_002, options)).toBeUndefined();
      }
    },
  );

  it("only grants one claimant and consumes an attempt across pre-dispatch crashes", () => {
    const { task, claim, options } = fixture();
    const first = claim();
    heartbeatTaskSupervisor("owner-b", 1000, 10_000, options);
    expect(claimSupervisedTask(task.flowId, "owner-b", 1000, options)).toBeUndefined();
    stopTaskSupervisor("owner-a", 1001, options);
    const second = claimSupervisedTask(task.flowId, "owner-b", 1002, options)!;
    expect(second.attempts).toBe(first.attempts + 1);
    expect(() => reserveSupervisedDispatch(first, 1002, options)).toThrow("no longer owns");
  });

  it("records cancellation without assuming a running external effect stopped", () => {
    const { task, claim, options } = fixture();
    const attempt = reserveSupervisedDispatch(claim(), 1000, options);
    const cancelled = cancelSupervisedTask(task.flowId, 1001, options);
    expect(cancelled).toMatchObject({ phase: "cancelled", endpoint: { effects: "unknown" } });
    expect(() => settleSupervisedDecision(attempt, complete(task), 1002, options)).toThrow(
      "no longer owns",
    );
    expect(cancelSupervisedTask(task.flowId, 1003, options)).toEqual(cancelled);
  });

  it("rejects waits beyond the deadline and expires queued work independently", () => {
    const { task, claim, options } = fixture();
    const attempt = reserveSupervisedDispatch(claim(), 1000, options);
    expect(() =>
      settleSupervisedDecision(
        attempt,
        { kind: "wait", next: "Check later", wakeAt: 60_001 },
        1001,
        options,
      ),
    ).toThrow("before the episode deadline");
    settleSupervisedDecision(
      attempt,
      { kind: "wait", next: "Check later", wakeAt: 50_000 },
      1001,
      options,
    );
    reconcileSupervisedTasks(60_001, options);
    expect(getSupervisedTask(task.flowId, options)?.phase).toBe("failed");
  });

  it("does not label stale supervision as armed or operator-free progress", () => {
    const { task, options } = fixture();
    expect(inspectTaskSupervision(task.flowId, 1000, options)).toMatchObject({
      continuation: "armed",
      execution: "not_observed",
      supervisorExpiresAt: 11_000,
    });
    expect(inspectTaskSupervision(task.flowId, 11_001, options)).toMatchObject({
      continuation: "unknown",
      execution: "not_observed",
      operatorRequired: false,
    });
  });

  it("does not borrow a foreground worker's custody for another flow", () => {
    const { task, options } = fixture();
    stopTaskSupervisor("owner-a", 1001, options);
    heartbeatTaskSupervisor("scoped", 1002, 10_000, options, "different-flow");
    expect(inspectTaskSupervision(task.flowId, 1002, options)?.continuation).toBe("unknown");
    expect(claimSupervisedTask(task.flowId, "scoped", 1002, options)).toBeUndefined();
    expect(() => heartbeatTaskSupervisor("scoped", 1003, 10_000, options)).toThrow("cannot renew");
    heartbeatTaskSupervisor("exact-scope", 1002, 10_000, options, task.flowId);
    expect(inspectTaskSupervision(task.flowId, 1002, options)?.continuation).toBe("armed");
    expect(claimSupervisedTask(task.flowId, "exact-scope", 1002, options)?.phase).toBe("running");
  });

  it("ends an otherwise unbounded continue loop at the accepted attempt budget", () => {
    const { task, options, claim } = fixture();
    for (let step = 0; step < policy.maxAttempts; step++) {
      const attempt = reserveSupervisedDispatch(claim(1000 + step), 1000 + step, options);
      settleSupervisedDecision(
        attempt,
        { kind: "continue", next: "Another bounded step" },
        1000 + step,
        options,
      );
    }
    expect(getSupervisedTask(task.flowId, options)).toMatchObject({
      phase: "failed",
      attempts: policy.maxAttempts,
    });
    expect(claimSupervisedTask(task.flowId, "owner-a", 1010, options)).toBeUndefined();
  });

  it("keeps successful settlement when status observers throw", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("supervised-observer-") } };
    const worker = startSupervisedTaskWorker({
      options,
      runAttempt: async (task) => complete(task),
      onError: () => {
        throw new Error("broken log sink");
      },
      onChange: () => {
        throw new Error("broken status sink");
      },
    });
    workers.push(worker);
    const task = createSupervisedTask(
      {
        agentId: "poc",
        model: "openai/test",
        runtime: "codex",
        prompt: "Check work",
        goal,
        policy,
      },
      worker.ownerId,
      1000,
      options,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSupervisedTask(task.flowId, options)?.phase).toBe("succeeded");
    expect(worker.stopped).toBe(false);
  });

  it("keeps deadline reconciliation alive while an attempt promise never resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const options = { env: { OPENCLAW_STATE_DIR: tempDirs.make("supervised-hung-") } };
    const runAttempt = vi.fn(() => new Promise<never>(() => {}));
    const worker = startSupervisedTaskWorker({ options, runAttempt, onError: vi.fn() });
    workers.push(worker);
    const task = createSupervisedTask(
      {
        agentId: "poc",
        model: "openai/test",
        runtime: "codex",
        prompt: "Check work",
        goal,
        policy: { ...policy, attemptTimeoutMs: 1000 },
      },
      worker.ownerId,
      1000,
      options,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(runAttempt).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getSupervisedTask(task.flowId, options)).toMatchObject({
      phase: "input_required",
      endpoint: { effects: "unknown" },
    });
    expect(runAttempt.mock.calls[0]).toBeDefined();
  });
});
