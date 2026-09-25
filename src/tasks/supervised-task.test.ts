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
  listSupervisedTasks,
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
  it.each(["cancel", "execute"] as const)(
    "preserves pre-headroom content during %s without starving other work",
    async (action) => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      const { task, options } = fixture();
      // An older writer admitted this record under the original aggregate cap.
      // Seed that historical shape directly, not through the stricter new writer.
      const legacy = {
        ...task,
        goal: {
          objective: "Keep the historical accepted goal intact",
          success: Array.from({ length: 14 }, (_, index) => ({
            id: `legacy-${index}`,
            description: "x".repeat(4096),
          })),
          partial: [],
        },
      };
      const serialized = JSON.stringify(legacy);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(40 * 1024);
      expect(Buffer.byteLength(serialized)).toBeLessThan(64 * 1024 - 1024);
      const { db } = openOpenClawStateDatabase(options);
      db.prepare("UPDATE task_flow_episodes SET record_json = ? WHERE flow_id = ?").run(
        serialized,
        task.flowId,
      );
      closeOpenClawStateDatabaseForTest();
      expect(getSupervisedTask(task.flowId, options)).toEqual(legacy);
      if (action === "execute") {
        const sibling = createSupervisedTask(
          {
            agentId: "poc",
            runtime: "codex",
            model: "openai/test",
            prompt: "Other work",
            goal,
            policy,
          },
          "owner-a",
          1000,
          options,
        );
        const onError = vi.fn();
        const worker = startSupervisedTaskWorker({
          options,
          runAttempt: async (claimed) => complete(claimed),
          onError,
        });
        workers.push(worker);
        await vi.advanceTimersByTimeAsync(3000);
        expect(getSupervisedTask(task.flowId, options)).toMatchObject({
          phase: "succeeded",
          goal: legacy.goal,
          prompt: legacy.prompt,
          next: legacy.next,
        });
        expect(getSupervisedTask(sibling.flowId, options)?.phase).toBe("succeeded");
        expect(worker.stopped).toBe(false);
        expect(onError).not.toHaveBeenCalled();
        return;
      }
      const cancelled = cancelSupervisedTask(task.flowId, 1001, options);
      expect(cancelled).toMatchObject({
        goal: legacy.goal,
        prompt: legacy.prompt,
        next: legacy.next,
        phase: "cancelled",
        endpoint: { effects: "not_dispatched" },
      });
      closeOpenClawStateDatabaseForTest();
      expect(getSupervisedTask(task.flowId, options)).toEqual(cancelled);
    },
  );

  it("rejects near-cap admission before inserting an episode", () => {
    const { options } = fixture();
    const before = listSupervisedTasks(options);
    const largeGoal = {
      objective: "Retain room to record a task endpoint",
      success: Array.from({ length: 14 }, (_, index) => ({
        id: `criterion-${index}`,
        description: "x".repeat(4096),
      })),
      partial: [],
    };
    expect(() =>
      createSupervisedTask(
        {
          flowId: "near-cap",
          agentId: "poc",
          model: "openai/test",
          runtime: "codex",
          prompt: "Complete the criteria",
          goal: largeGoal,
          policy,
        },
        "owner-a",
        1000,
        options,
      ),
    ).toThrow(/budget|headroom/i);
    expect(listSupervisedTasks(options)).toEqual(before);
    expect(getSupervisedTask("near-cap", options)).toBeUndefined();
  });

  it.each(["x", "\u0000", "漢"])(
    "keeps the largest admissible %j content claimable and terminable",
    (unit) => {
      const { options } = fixture();
      // Find the admission boundary through the real store, independently of
      // the chosen budget constants. Cancel probes so they consume no capacity.
      const input = (count: number) => ({
        agentId: "poc",
        model: "openai/test",
        runtime: "codex" as const,
        prompt: "Complete the criteria",
        goal: {
          objective: "Retain room for control metadata and an endpoint",
          success: Array.from({ length: 16 }, (_, index) => ({
            id: `criterion-${index}`,
            description: unit.repeat(count),
          })),
          partial: [],
        },
        policy,
      });
      let low = 1;
      let high = 4096;
      while (low < high) {
        const candidate = Math.ceil((low + high) / 2);
        let admitted: SupervisedTask;
        try {
          admitted = createSupervisedTask(input(candidate), "owner-a", 1000, options);
        } catch (error) {
          expect(String(error)).toMatch(/budget|headroom|64 KiB/i);
          high = candidate - 1;
          continue;
        }
        cancelSupervisedTask(admitted.flowId, 1000, options);
        low = candidate;
      }
      expect(low).toBeGreaterThan(1);
      const task = createSupervisedTask(input(low), "owner-a", 1000, options);
      const ownerId = "\u0000".repeat(128);
      heartbeatTaskSupervisor(ownerId, 1000, 10_000, options);
      const claimed = claimSupervisedTask(task.flowId, ownerId, 1000, options)!;
      const dispatched = reserveSupervisedDispatch(claimed, 1001, options);
      closeOpenClawStateDatabaseForTest();
      reconcileSupervisedTasks(11_001, options);
      const endpoint = getSupervisedTask(task.flowId, options)!;
      expect(endpoint).toMatchObject({
        goal: task.goal,
        prompt: task.prompt,
        next: task.next,
        lastAttemptId: dispatched.attempt!.id,
        phase: "input_required",
        endpoint: { effects: "unknown" },
      });
      expect(Buffer.byteLength(JSON.stringify(endpoint))).toBeLessThanOrEqual(64 * 1024);
      const { db } = openOpenClawStateDatabase(options);
      const stored = db
        .prepare("SELECT record_json FROM task_flow_episodes WHERE flow_id = ?")
        .get(task.flowId);
      // Verify the actual persisted JSON, including escaping and UTF-8, rather
      // than measuring a separately reconstructed approximation of its payload.
      expect(stored?.record_json).toBe(JSON.stringify(endpoint));
      expect(Buffer.byteLength(String(stored?.record_json))).toBeLessThanOrEqual(64 * 1024);
    },
  );

  it.each(["define_goal", "continue", "succeeded"] as const)(
    "rejects oversized %s atomically and still permits a compact endpoint",
    (kind) => {
      const { options } = fixture();
      const largeGoal = {
        objective: "Complete the listed checks",
        success: Array.from({ length: 16 }, (_, index) => ({
          id: `criterion-${index}`,
          description: "x".repeat(kind === "define_goal" ? 3500 : 1800),
        })),
        partial: [],
      };
      const task = createSupervisedTask(
        {
          agentId: "poc",
          model: "openai/test",
          runtime: "codex",
          prompt: "Work",
          ...(kind === "define_goal" ? {} : { goal: largeGoal }),
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
      const decision =
        kind === "define_goal"
          ? { kind, goal: largeGoal }
          : kind === "continue"
            ? { kind, next: "\u0000".repeat(4096) }
            : {
                kind,
                summary: "Checked",
                evidence: largeGoal.success.map(({ id }) => ({
                  criterionId: id,
                  observation: "漢".repeat(400),
                })),
              };
      expect(() => settleSupervisedDecision(attempt, decision, 1001, options)).toThrow(
        /budget|headroom/i,
      );
      expect(getSupervisedTask(task.flowId, options)).toEqual(attempt);
      expect(
        failSupervisedAttempt(attempt, "Decision exceeds the accepted budget", 1002, options),
      ).toMatchObject({
        phase: "input_required",
        goal: task.goal,
        next: task.next,
        endpoint: { effects: "unknown" },
      });
    },
  );

  it("rejects oversized resume without changing the immutable input episode", () => {
    const { options } = fixture();
    const task = createSupervisedTask(
      {
        agentId: "poc",
        model: "openai/test",
        runtime: "codex",
        prompt: "Work",
        goal: {
          ...goal,
          success: Array.from({ length: 8 }, (_, index) => ({
            id: `criterion-${index}`,
            description: "x".repeat(3800),
          })),
          partial: [],
        },
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
    const endpoint = failSupervisedAttempt(attempt, "Need operator context", 1001, options)!;
    expect(() =>
      resumeSupervisedTask(task.flowId, 1, "\u0000".repeat(4096), policy, "owner-a", 1002, options),
    ).toThrow(/budget|headroom/i);
    expect(getSupervisedTask(task.flowId, options)).toEqual(endpoint);
    expect(getSupervisedTask(task.flowId, options, 2)).toBeUndefined();
  });

  it("rejects an overlong supervisor identity before inserting it", () => {
    const { options } = fixture();
    const { db } = openOpenClawStateDatabase(options);
    const before = db.prepare("SELECT * FROM task_flow_supervisors ORDER BY owner_id").all();
    expect(() => heartbeatTaskSupervisor("x".repeat(129), 1000, 10_000, options)).toThrow();
    expect(db.prepare("SELECT * FROM task_flow_supervisors ORDER BY owner_id").all()).toEqual(
      before,
    );
  });

  it("records bounded explicit diagnostics when supervisor failure detail is oversized", () => {
    const { task, claim, options } = fixture();
    const attempt = reserveSupervisedDispatch(claim(), 1000, options);
    const endpoint = failSupervisedAttempt(attempt, "\u0000".repeat(4096), 1001, options)!;
    expect(endpoint).toMatchObject({
      phase: "input_required",
      goal: task.goal,
      next: task.next,
      endpoint: { effects: "unknown" },
    });
    expect(endpoint.endpoint!.reason).toMatch(/detail.*(exceed|omit)|budget/i);
    expect(Buffer.byteLength(JSON.stringify(endpoint.endpoint))).toBeLessThanOrEqual(16 * 1024);
  });

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
