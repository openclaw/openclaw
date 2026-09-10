import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { controlSupervisedTask } from "./supervised-task.controls.js";
import {
  assertSupervisedAttemptCurrent,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
  settleSupervisedDecision,
} from "./supervised-task.store.js";
import { verifySupervisedWorkflowAcceptance } from "./supervised-workflow.acceptance.js";
import { writeSupervisedWorkflow } from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  getSupervisedWorkspaceHead,
  ensureSupervisedAttemptSource,
} from "./supervised-workspace-versions.js";
const dirs = createTempDirTracker();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
async function fixture(largeRecord = false) {
  const root = dirs.make("task-control-");
  const workspace = `${root}/work`;
  await fs.mkdir(workspace);
  await fs.writeFile(`${workspace}/answer.txt`, "correct\n");
  const options = { path: `${root}/state.sqlite` };
  const goal = {
    objective: "Produce correct reviewed output",
    success: [
      {
        id: "reviewed",
        description: largeRecord ? "r".repeat(4096) : "Operator reviewed exact output",
      },
      { id: "correct", description: "Host digest matches" },
    ],
    partial: [],
  };
  const contract = encodeSupervisedWorkflowContract(
    {
      version: 1,
      workspace,
      profiles: [],
      acceptance: [
        { kind: "operator", criterionId: "reviewed" },
        {
          kind: "artifact",
          criterionId: "correct",
          path: "answer.txt",
          sha256: createHash("sha256").update("correct\n").digest("hex"),
        },
      ],
    },
    goal,
  ).contract;
  const policy = { deadlineAt: 60_000, maxAttempts: 6, attemptTimeoutMs: 10_000 };
  heartbeatTaskSupervisor("native", 1000, 60_000, options);
  createSupervisedTask(
    {
      flowId: "work",
      agentId: "poc",
      model: "openai/test",
      runtime: "codex",
      prompt: largeRecord ? "p".repeat(4096) : "Repair",
      goal,
      policy,
      workflow: contract,
    },
    "native",
    1000,
    options,
  );
  const claim = () =>
    reserveSupervisedDispatch(claimSupervisedTask("work", "native", 1000, options)!, 1000, options);
  const attempt = claim();
  const guard = () => assertSupervisedAttemptCurrent(attempt, 1000, options);
  await ensureSupervisedAttemptSource(attempt, contract, options, guard);
  const authority = {
    actorId: "operator-session",
    assertCurrent: vi.fn(),
    supervisorOwnerId: "native",
  };
  const control = (action: Parameters<typeof controlSupervisedTask>[0], inputId = "input") => {
    const task = getSupervisedTask("work", options)!;
    return controlSupervisedTask(
      { flowId: "work", episode: task.episode, revision: task.revision, inputId, action },
      authority,
      1000,
      options,
    );
  };
  return { options, contract, policy, attempt, authority, control, claim };
}
it("steering revokes the old model attempt without changing its accepted goal or budget", async () => {
  const f = await fixture();
  const before = getSupervisedTask("work", f.options)!;
  const acknowledgement = f.control({ kind: "steer", input: "Also handle the empty fixture" });
  const after = getSupervisedTask("work", f.options)!;
  expect(acknowledgement).toEqual({
    flowId: "work",
    episode: after.episode,
    revision: after.revision,
    phase: "ready",
  });
  expect(after).toMatchObject({
    goal: before.goal,
    policy: before.policy,
    attempts: before.attempts,
    phase: "ready",
    attempt: null,
  });
  expect(() => assertSupervisedAttemptCurrent(f.attempt, 1000, f.options)).toThrow(/no longer/);
  expect(after.next).toBe("Also handle the empty fixture");
});
it("rejects stale and unauthorized controls before mutation and replays an exact cancellation once", async () => {
  const f = await fixture();
  const before = getSupervisedTask("work", f.options)!;
  const request = {
    flowId: "work",
    episode: 1,
    revision: before.revision,
    inputId: "cancel-one",
    action: { kind: "cancel" },
  };
  expect(() =>
    controlSupervisedTask(
      { ...request, revision: before.revision - 1 },
      f.authority,
      1000,
      f.options,
    ),
  ).toThrow(/changed/);
  expect(() =>
    controlSupervisedTask(
      request,
      {
        ...f.authority,
        assertCurrent: () => {
          throw new Error("Access revoked");
        },
      },
      1000,
      f.options,
    ),
  ).toThrow("Access revoked");
  expect(getSupervisedTask("work", f.options)).toEqual(before);
  const cancelled = controlSupervisedTask(request, f.authority, 1000, f.options);
  expect(controlSupervisedTask(request, f.authority, 1001, f.options)).toEqual(cancelled);
  expect(() =>
    controlSupervisedTask(
      { ...request, action: { kind: "steer", input: "Changed" } },
      f.authority,
      1001,
      f.options,
    ),
  ).toThrow(/reused/);
});
it("accepts an operator receipt only for the exact retained artifact and preserves the prior input endpoint", async () => {
  const f = await fixture();
  const endpoint = settleSupervisedDecision(
    f.attempt,
    { kind: "input_required", reason: "Review ready", question: "Accept this output?" },
    1000,
    f.options,
  );
  const head = getSupervisedWorkspaceHead("work", 1, f.options)!;
  f.control(
    { kind: "approve", sourceHash: head.source_hash, criterionIds: ["reviewed"] },
    "approve-one",
  );
  expect(getSupervisedTask("work", f.options)).toEqual(endpoint);
  const resumed = f.control(
    { kind: "resume", input: "Operator reviewed; verify all accepted criteria", policy: f.policy },
    "resume-one",
  );
  expect(resumed.episode).toBe(2);
  expect(getSupervisedTask("work", f.options, 1)).toEqual(endpoint);
  const current = f.claim();
  const decision = {
    kind: "succeeded" as const,
    summary: "Completed",
    evidence: [
      { criterionId: "reviewed", observation: "claimed" },
      { criterionId: "correct", observation: "claimed" },
    ],
  };
  const check = await verifySupervisedWorkflowAcceptance(current, decision, f.options);
  expect(check.kind).toBe("verified");
  if (check.kind !== "verified") {
    throw new Error("Expected verified acceptance");
  }
  const done = settleSupervisedDecision(current, decision, 1000, f.options, check.proof);
  expect(done.endpoint?.acceptedBy).toBe("supervisor");
  expect(done.endpoint?.evidence[0]?.observation).toContain("Operator accepted exact artifact");
});
it("operator approval cannot waive an automated criterion or name a different artifact", async () => {
  const f = await fixture();
  const head = getSupervisedWorkspaceHead("work", 1, f.options)!;
  expect(() =>
    f.control({ kind: "approve", sourceHash: head.source_hash, criterionIds: ["correct"] }),
  ).toThrow(/automated/);
  expect(() =>
    f.control({ kind: "approve", sourceHash: "f".repeat(64), criterionIds: ["reviewed"] }),
  ).toThrow(/exact retained/);
});

it.each(["steer", "resume"] as const)(
  "replays the original %s acknowledgement after later control and database reopen",
  async (kind) => {
    const f = await fixture();
    if (kind === "resume") {
      settleSupervisedDecision(
        f.attempt,
        {
          kind: "input_required",
          reason: "Review ready",
          question: "Continue?",
        },
        1000,
        f.options,
      );
    }
    const before = getSupervisedTask("work", f.options)!;
    const request = {
      flowId: "work",
      episode: before.episode,
      revision: before.revision,
      inputId: "lost-response",
      action:
        kind === "resume"
          ? { kind, input: "Continue within the original goal", policy: f.policy }
          : { kind, input: "Handle the empty fixture" },
    };
    const original = controlSupervisedTask(request, f.authority, 1000, f.options);
    expect(original.phase).toBe("ready");
    f.control({ kind: "cancel" }, "later-cancellation");
    const current = getSupervisedTask("work", f.options)!;
    expect(current.phase).toBe("cancelled");
    closeOpenClawStateDatabaseForTest();
    expect(controlSupervisedTask(request, f.authority, 1001, f.options)).toEqual(original);
    expect(getSupervisedTask("work", f.options)).toEqual(current);
    expect(() =>
      controlSupervisedTask(
        request,
        {
          ...f.authority,
          assertCurrent: () => {
            throw new Error("Access revoked after original control");
          },
        },
        1001,
        f.options,
      ),
    ).toThrow("Access revoked after original control");
  },
);

it("retains cancellation replay for tasks larger than the input receipt byte budget", async () => {
  const f = await fixture(true);
  const before = getSupervisedTask("work", f.options)!;
  expect(Buffer.byteLength(JSON.stringify(before))).toBeGreaterThan(8192);
  const request = {
    flowId: "work",
    episode: before.episode,
    revision: before.revision,
    inputId: "large-task-cancel",
    action: { kind: "cancel" },
  };
  const original = controlSupervisedTask(request, f.authority, 1000, f.options);
  expect(original).toMatchObject({ flowId: "work", phase: "cancelled" });
  closeOpenClawStateDatabaseForTest();
  expect(controlSupervisedTask(request, f.authority, 1001, f.options)).toEqual(original);
  expect(getSupervisedTask("work", f.options)?.phase).toBe("cancelled");
});

it("reports a legacy request-only receipt without fabricating or applying another control", async () => {
  const f = await fixture();
  const before = getSupervisedTask("work", f.options)!;
  const request = {
    flowId: "work",
    episode: before.episode,
    revision: before.revision,
    inputId: "legacy-control",
    action: { kind: "steer", input: "Handle the empty fixture" },
  };
  controlSupervisedTask(request, f.authority, 1000, f.options);
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("task_flow_inputs")
          .set({ record_json: JSON.stringify(request) })
          .where("flow_id", "=", "work")
          .where("disposition", "=", "steered"),
      ),
    f.options,
  );
  const current = getSupervisedTask("work", f.options);
  closeOpenClawStateDatabaseForTest();
  expect(() => controlSupervisedTask(request, f.authority, 1001, f.options)).toThrow(
    "original acknowledgement is unavailable",
  );
  expect(getSupervisedTask("work", f.options)).toEqual(current);
});
