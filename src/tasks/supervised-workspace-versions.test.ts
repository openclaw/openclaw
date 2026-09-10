import fs from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { prepareAttemptCandidateFixture } from "./supervised-attempt-candidate.test-support.js";
import { candidateKernel } from "./supervised-attempt-kernel.test-support.js";
import { quarantineSupervisedTask } from "./supervised-task.recovery.js";
import {
  assertSupervisedAttemptCurrent,
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  failSupervisedAttempt,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reconcileSupervisedTasks,
  reserveSupervisedDispatch,
  stopTaskSupervisor,
} from "./supervised-task.store.js";
import { readSupervisedWorkflow } from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  reserveSupervisedWorkspace,
  retireSupervisedWorkspaces,
} from "./supervised-workspace-retention.js";
import {
  ensureSupervisedAttemptSource,
  resolveSupervisedWorkflowWorkspace,
} from "./supervised-workspace-versions.js";

vi.mock("./supervised-process-resources.js", async (importOriginal) => {
  const { mockAttemptKernel } = await import("./supervised-attempt-kernel.test-support.js");
  return mockAttemptKernel(importOriginal);
});
const dirs = createTempDirTracker();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  candidateKernel.closed.mockReset().mockResolvedValue(true);
  candidateKernel.member.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});
async function fixture() {
  const root = dirs.make("supervised-artifacts-");
  const options = { path: `${root}/state.sqlite` };
  const workspace = `${root}/input`;
  await fs.mkdir(workspace);
  await fs.writeFile(`${workspace}/answer.txt`, "initial\n");
  const contract = encodeSupervisedWorkflowContract({
    version: 1,
    workspace,
    profiles: [],
    acceptance: [{ kind: "operator", criterionId: "correct" }],
    maxRecoveryAttempts: 2,
  }).contract;
  heartbeatTaskSupervisor("one", 1000, 10_000, options);
  const task = createSupervisedTask(
    {
      flowId: "work",
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Repair accepted source",
      goal: {
        objective: "Repair",
        success: [{ id: "correct", description: "Correct output" }],
        partial: [],
      },
      policy: { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
      workflow: contract,
    },
    "one",
    1000,
    options,
  );
  const claim = (owner: string) =>
    reserveSupervisedDispatch(
      claimSupervisedTask(task.flowId, owner, Date.now(), options)!,
      Date.now(),
      options,
    );
  return { root, options, workspace, contract, task, claim };
}

it("accepts a frozen copy, not the runtime's still-writable draft or the input workspace", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const assertCurrent = () => assertSupervisedAttemptCurrent(attempt, Date.now(), f.options);
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, assertCurrent);
  await fs.writeFile(`${draft.workspace}/answer.txt`, "accepted\n");
  await draft.stage({ kind: "continue", next: "Inspect" });
  expect(await draft.close()).toBe(true);
  await draft.accept();
  await fs.writeFile(`${draft.workspace}/answer.txt`, "late mutation\n");
  const accepted = resolveSupervisedWorkflowWorkspace(f.contract, "work", 1, f.options);
  expect(await fs.readFile(`${accepted.workspace}/answer.txt`, "utf8")).toBe("accepted\n");
  expect(await fs.readFile(`${f.workspace}/answer.txt`, "utf8")).toBe("initial\n");
});

it("recovers a lost coordinator from the accepted artifact while stale draft writes cannot cross back", async () => {
  const f = await fixture();
  const first = f.claim("one");
  const oldGuard = () => assertSupervisedAttemptCurrent(first, Date.now(), f.options);
  const oldDraft = await prepareAttemptCandidateFixture(first, f.contract, f.options, oldGuard);
  await fs.writeFile(`${oldDraft.workspace}/answer.txt`, "unaccepted\n");
  await oldDraft.stage({ kind: "continue", next: "Unaccepted candidate" });
  stopTaskSupervisor("one", 1000, f.options);
  expect(await oldDraft.close()).toBe(true);
  reconcileSupervisedTasks(1000, f.options);
  expect(getSupervisedTask("work", f.options)).toMatchObject({
    phase: "ready",
    endpoint: null,
    dueAt: 2000,
  });
  vi.setSystemTime(2000);
  heartbeatTaskSupervisor("two", 2000, 10_000, f.options);
  const second = f.claim("two");
  const guard = () => assertSupervisedAttemptCurrent(second, Date.now(), f.options);
  const fresh = await prepareAttemptCandidateFixture(second, f.contract, f.options, guard);
  expect(await fs.readFile(`${fresh.workspace}/answer.txt`, "utf8")).toBe("initial\n");
  await fs.writeFile(`${fresh.workspace}/answer.txt`, "repaired\n");
  await fs.writeFile(`${oldDraft.workspace}/answer.txt`, "stale write after takeover\n");
  await expect(oldDraft.accept()).rejects.toThrow(/no longer/);
  await fresh.stage({ kind: "continue", next: "Inspect repaired output" });
  expect(await fresh.close()).toBe(true);
  await fresh.accept();
  const accepted = resolveSupervisedWorkflowWorkspace(f.contract, "work", 1, f.options);
  expect(await fs.readFile(`${accepted.workspace}/answer.txt`, "utf8")).toBe("repaired\n");
});

it("bounds automatic recovery without resetting the accepted attempt budget", async () => {
  const f = await fixture();
  for (let index = 0; index < 3; index += 1) {
    const now = 1000 + index * 4000;
    vi.setSystemTime(now);
    heartbeatTaskSupervisor("one", now, 10_000, f.options);
    const attempt = f.claim("one");
    failSupervisedAttempt(attempt, "Backend disconnected", now, f.options);
  }
  expect(getSupervisedTask("work", f.options)).toMatchObject({
    attempts: 3,
    phase: "input_required",
  });
});

const expired = 31 * 86_400_000;

it("reserves capacity before IO, including drafts that never became accepted versions", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  for (let n = 0; n < 8; n += 1) {
    reserveSupervisedWorkspace({ kind: "attempt", task: attempt }, "draft", Date.now(), f.options);
  }
  await expect(
    ensureSupervisedAttemptSource(attempt, f.contract, f.options, () =>
      assertSupervisedAttemptCurrent(attempt, Date.now(), f.options),
    ),
  ).rejects.toThrow(/capacity exhausted/);
  await expect(fs.stat(`${f.root}/taskflow-workspaces`)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(`${f.workspace}/answer.txt`, "utf8")).toBe("initial\n");
});

it("does not confuse an expired SQL owner with physical extinction of a writable draft", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, () =>
    assertSupervisedAttemptCurrent(attempt, Date.now(), f.options),
  );
  cancelSupervisedTask("work", 1000, f.options);
  vi.setSystemTime(expired);
  await retireSupervisedWorkspaces(expired, f.options);
  // A live resource holds both accepted history and the draft despite SQL
  // cancellation and thirty days without a lease.
  await fs.writeFile(`${draft.workspace}/answer.txt`, "late but isolated");
  expect(await fs.readFile(`${draft.workspace}/answer.txt`, "utf8")).toBe("late but isolated");
  expect(await draft.close()).toBe(true);
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(1);
  expect(await retireSupervisedWorkspaces(expired * 2, f.options)).toBe(1);
  await expect(fs.stat(draft.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(getSupervisedTask("work", f.options)?.phase).toBe("cancelled");
});

it("keeps input-required evidence across reopen and never sweeps unowned directories", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, () =>
    assertSupervisedAttemptCurrent(attempt, Date.now(), f.options),
  );
  // Exhaust recovery before recording the uncertainty endpoint.
  for (const now of [1000, 5000, 9000]) {
    vi.setSystemTime(now);
    heartbeatTaskSupervisor("one", now, 10_000, f.options);
    failSupervisedAttempt(
      now === 1000 ? attempt : f.claim("one"),
      "unknown effect",
      now,
      f.options,
    );
  }
  expect(getSupervisedTask("work", f.options)?.phase).toBe("input_required");
  expect(await draft.close()).toBe(true);
  const outside = `${f.root}/taskflow-workspaces/unowned`;
  await fs.mkdir(outside);
  await fs.writeFile(`${outside}/keep`, "operator");
  closeOpenClawStateDatabaseForTest();
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(0);
  expect(await fs.readFile(`${draft.workspace}/answer.txt`, "utf8")).toBe("initial\n");
  expect(await fs.readFile(`${outside}/keep`, "utf8")).toBe("operator");
});

it("retires only owned terminal artifacts and keeps receipt tombstones after reopening", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, () =>
    assertSupervisedAttemptCurrent(attempt, Date.now(), f.options),
  );
  expect(await draft.close()).toBe(true);
  cancelSupervisedTask("work", 1000, f.options);
  closeOpenClawStateDatabaseForTest();
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(2);
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(0);
  const tombstones = readSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_workspace_allocations")
          .select(["state", "reserved_bytes"]),
      ).rows,
    f.options,
  );
  expect(tombstones).toEqual([
    { state: "deleted", reserved_bytes: 0 },
    { state: "deleted", reserved_bytes: 0 },
  ]);
  expect(await fs.readFile(`${f.workspace}/answer.txt`, "utf8")).toBe("initial\n");
  expect(getSupervisedTask("work", f.options)?.phase).toBe("cancelled");
});

it("starts retention at the terminal observation, not at an old artifact's creation", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, () =>
    assertSupervisedAttemptCurrent(attempt, Date.now(), f.options),
  );
  expect(await draft.close()).toBe(true);
  vi.setSystemTime(expired);
  cancelSupervisedTask("work", expired, f.options);
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(0);
  expect(await fs.readFile(`${draft.workspace}/answer.txt`, "utf8")).toBe("initial\n");
  expect(await retireSupervisedWorkspaces(expired * 2, f.options)).toBe(2);
});

it("retires accepted scratch only after its writer joins, including after SQLite reopen", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const guard = () => assertSupervisedAttemptCurrent(attempt, Date.now(), f.options);
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, guard);
  await fs.writeFile(`${draft.workspace}/answer.txt`, "accepted\n");
  await draft.stage({ kind: "continue", next: "Inspect" });
  await expect(draft.accept()).rejects.toThrow(/physical resource closure/);
  expect(await retireSupervisedWorkspaces(Date.now(), f.options)).toBe(0);
  await fs.writeFile(`${draft.workspace}/answer.txt`, "writer not yet joined\n");
  expect(await draft.close()).toBe(true);
  await draft.accept();
  const accepted = resolveSupervisedWorkflowWorkspace(f.contract, "work", 1, f.options);
  closeOpenClawStateDatabaseForTest();
  expect(await retireSupervisedWorkspaces(Date.now(), f.options)).toBe(1);
  await expect(fs.stat(draft.workspace)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fs.readFile(`${accepted.workspace}/answer.txt`, "utf8")).toBe("accepted\n");
  expect(await fs.readFile(`${f.workspace}/answer.txt`, "utf8")).toBe("initial\n");
  expect(getSupervisedTask("work", f.options)?.phase).toBe("ready");
  expect(await retireSupervisedWorkspaces(Date.now(), f.options)).toBe(0);
});

it("continues nine accepted attempts without exhausting scratch capacity or losing accepted history", async () => {
  const f = await fixture();
  const acceptedPaths: string[] = [];
  for (let index = 0; index < 9; index += 1) {
    const attempt = f.claim("one");
    const guard = () => assertSupervisedAttemptCurrent(attempt, Date.now(), f.options);
    const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, guard);
    await fs.writeFile(`${draft.workspace}/answer.txt`, `accepted ${index}\n`);
    await draft.stage({ kind: "continue", next: "Refine" });
    expect(await draft.close()).toBe(true);
    await draft.accept();
    acceptedPaths.push(
      resolveSupervisedWorkflowWorkspace(f.contract, "work", 1, f.options).workspace,
    );
    await retireSupervisedWorkspaces(Date.now(), f.options);
    closeOpenClawStateDatabaseForTest();
  }
  expect(getSupervisedTask("work", f.options)).toMatchObject({ phase: "ready", attempts: 9 });
  for (const [index, workspace] of acceptedPaths.entries()) {
    expect(await fs.readFile(`${workspace}/answer.txt`, "utf8")).toBe(`accepted ${index}\n`);
  }
  const allocations = readSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .selectFrom("task_flow_workspace_allocations")
          .select(["kind", "state", "reserved_bytes"]),
      ).rows,
    f.options,
  );
  expect(allocations?.filter((row) => row.kind === "draft")).toEqual(
    Array.from({ length: 9 }, () => ({ kind: "draft", state: "deleted", reserved_bytes: 0 })),
  );
});

it("retains accepted scratch when the joined attempt ends input-required", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const guard = () => assertSupervisedAttemptCurrent(attempt, Date.now(), f.options);
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, guard);
  await draft.stage({
    kind: "input_required",
    reason: "Need operator evidence",
    question: "Which result is correct?",
  });
  expect(await draft.close()).toBe(true);
  await draft.accept();
  expect(getSupervisedTask("work", f.options)?.phase).toBe("input_required");
  closeOpenClawStateDatabaseForTest();
  expect(await retireSupervisedWorkspaces(Date.now(), f.options)).toBe(0);
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(0);
  expect(await fs.readFile(`${draft.workspace}/answer.txt`, "utf8")).toBe("initial\n");
});

it("keeps joined but unaccepted scratch as evidence in an active workflow", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, () =>
    assertSupervisedAttemptCurrent(attempt, Date.now(), f.options),
  );
  await fs.writeFile(`${draft.workspace}/answer.txt`, "not accepted\n");
  expect(await draft.close()).toBe(true);
  closeOpenClawStateDatabaseForTest();
  expect(await retireSupervisedWorkspaces(Date.now(), f.options)).toBe(0);
  expect(await fs.readFile(`${draft.workspace}/answer.txt`, "utf8")).toBe("not accepted\n");
});

it("does not discard accepted and joined scratch after the flow is quarantined", async () => {
  const f = await fixture();
  const attempt = f.claim("one");
  const guard = () => assertSupervisedAttemptCurrent(attempt, Date.now(), f.options);
  const draft = await prepareAttemptCandidateFixture(attempt, f.contract, f.options, guard);
  await draft.stage({ kind: "continue", next: "Inspect" });
  expect(await draft.close()).toBe(true);
  await draft.accept();
  quarantineSupervisedTask("work", 1, Date.now(), f.options);
  closeOpenClawStateDatabaseForTest();
  expect(await retireSupervisedWorkspaces(Date.now(), f.options)).toBe(0);
  expect(await retireSupervisedWorkspaces(expired, f.options)).toBe(0);
  expect(await fs.readFile(`${draft.workspace}/answer.txt`, "utf8")).toBe("initial\n");
});

it("rejects an aliased artifact root before creating any external directory", async () => {
  const f = await fixture();
  const outside = dirs.make("artifact-outside-");
  await fs.writeFile(`${outside}/sentinel`, "preserve");
  await fs.symlink(outside, `${f.root}/taskflow-workspaces`);
  const task = f.claim("one");
  await expect(
    ensureSupervisedAttemptSource(task, f.contract, f.options, () =>
      assertSupervisedAttemptCurrent(task, Date.now(), f.options),
    ),
  ).rejects.toThrow();
  expect(await fs.readdir(outside)).toEqual(["sentinel"]);
  expect(await fs.readFile(`${outside}/sentinel`, "utf8")).toBe("preserve");
});
