import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  acceptSupervisedAttemptCandidate,
  consumeSupervisedAttemptSettlement,
  stageSupervisedAttemptCandidate,
  stageSupervisedAttemptDecision,
} from "./supervised-attempt-candidate.js";
import {
  beginSupervisedAttemptLaunch,
  bindSupervisedAttemptResources,
  closeSupervisedAttemptResources,
  recordSupervisedAttemptLauncherJoined,
  reserveSupervisedAttemptPayload,
  reserveSupervisedAttemptResources,
  revokeSupervisedAttemptResources,
} from "./supervised-attempt-custody.js";
import { listSupervisedOperations } from "./supervised-operation.store.js";
import { controlSupervisedTask } from "./supervised-task.controls.js";
import {
  assertSupervisedAttemptCurrent,
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
} from "./supervised-task.store.js";
import type { SupervisedDecision } from "./supervised-task.types.js";
import { readSupervisedWorkflow } from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import {
  getSupervisedWorkspaceHead,
  prepareSupervisedAttemptWorkspace,
  supervisedWorkspaceVersionPath,
} from "./supervised-workspace-versions.js";

const controls = vi.hoisted(() => ({
  member: vi.fn(),
  closed: vi.fn(),
  verify: vi.fn<() => Promise<void>>(),
}));
// Only kernel facts are simulated. All task/resource/candidate transactions,
// artifact reads/copies, operation authorization and acceptance verification are real.
// This suite proves SQL composition, not physical namespace or process extinction.
vi.mock("./supervised-process-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervised-process-resources.js")>()),
  supervisedProcessScopeName: (id: string) => `openclaw-task-${id}.scope`,
  readSupervisedProcessHostIdentity: () => ({
    hostId: "a".repeat(64),
    bootId: "e1b0a23e-26d8-4ee6-ac6c-e67a10cc5c99",
  }),
  validateSupervisedProcessResourceLimits: () => {},
  inspectSupervisedProcessScope: async ({
    resourceId,
    limits,
  }: {
    resourceId: string;
    limits: { memoryBytes: number; tasks: number };
  }) => ({
    resourceId,
    scopeName: `openclaw-task-${resourceId}.scope`,
    invocationId: "b".repeat(32),
    controlGroup: `/fixture/${resourceId}`,
    hostId: "a".repeat(64),
    bootId: "e1b0a23e-26d8-4ee6-ac6c-e67a10cc5c99",
    custodian: requireNodeWorkerProcessIdentity(process.pid),
    cgroupDevice: "25",
    cgroupInode: "100",
    limits,
  }),
  isSupervisedProcessScopeClosed: controls.closed,
  isSealedSupervisedProcessScopeAbsent: async () => true,
  assertSupervisedProcessScopeMember: controls.member,
}));
vi.mock("./supervised-workflow.acceptance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./supervised-workflow.acceptance.js")>();
  return {
    ...actual,
    verifySupervisedWorkflowAcceptance: async (
      ...args: Parameters<typeof actual.verifySupervisedWorkflowAcceptance>
    ) => {
      await controls.verify();
      return actual.verifySupervisedWorkflowAcceptance(...args);
    },
  };
});
const dirs = createTempDirTracker();
const success = {
  kind: "succeeded",
  summary: "Candidate ready",
  evidence: [{ criterionId: "correct", observation: "Please verify the artifact" }],
} satisfies SupervisedDecision;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  controls.closed.mockReset().mockResolvedValue(true);
  controls.member.mockReset();
  controls.verify.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  dirs.cleanup();
});

async function fixture(
  decision: SupervisedDecision = success,
  mode: "artifact" | "receipts" | "operator" | "none" = "artifact",
) {
  const root = dirs.make("candidate-transaction-");
  const workspace = path.join(root, "input");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "answer.txt"), "old\n");
  const options = { path: path.join(root, "state.sqlite") };
  const goal = {
    objective: "Produce the accepted bytes",
    success: [{ id: "correct", description: "Host check accepts output" }],
    partial: [],
  };
  const workflow =
    mode === "none"
      ? undefined
      : encodeSupervisedWorkflowContract(
          {
            version: 1,
            workspace,
            profiles: [
              {
                kind: "command",
                id: "check",
                executable: process.execPath,
                executableSha256: "0".repeat(64),
                argv: ["--version"],
                timeoutMs: 1000,
              },
            ],
            acceptance: [
              mode === "artifact"
                ? {
                    kind: "artifact",
                    criterionId: "correct",
                    path: "answer.txt",
                    sha256: createHash("sha256").update("new\n").digest("hex"),
                  }
                : mode === "receipts"
                  ? { kind: "receipts", criterionId: "correct", profiles: ["check"] }
                  : { kind: "operator", criterionId: "correct" },
            ],
          },
          goal,
        ).contract;
  heartbeatTaskSupervisor("owner", 1000, 60_000, options);
  const task = createSupervisedTask(
    {
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Produce bytes",
      goal,
      workflow,
      policy: { deadlineAt: 300_000, maxAttempts: 6, attemptTimeoutMs: 60_000 },
    },
    "owner",
    1000,
    options,
  );
  const claimed = claimSupervisedTask(task.flowId, "owner", 1000, options);
  if (!claimed) {
    throw new Error("Fixture claim failed");
  }
  const expected = reserveSupervisedDispatch(claimed, 1000, options);
  if (workflow) {
    await prepareSupervisedAttemptWorkspace(expected, workflow, options, () =>
      assertSupervisedAttemptCurrent(expected, Date.now(), options),
    );
  }
  const oldHead = getSupervisedWorkspaceHead(task.flowId, task.episode, options);
  const plan = reserveSupervisedAttemptResources(
    expected,
    { memoryBytes: 2 * 1024 ** 3, tasks: 128 },
    options,
  );
  beginSupervisedAttemptLaunch(plan.resourceId, options);
  await bindSupervisedAttemptResources(plan.resourceId, options);
  reserveSupervisedAttemptPayload(plan.resourceId, options);
  stageSupervisedAttemptDecision(plan.resourceId, JSON.stringify(decision), options);
  if (workflow) {
    const exported = path.join(
      supervisedWorkspaceVersionPath(plan.allocationId, options),
      "export",
    );
    await fs.mkdir(exported, { recursive: true });
    await fs.writeFile(path.join(exported, "answer.txt"), "new\n");
  }
  const close = async () => {
    revokeSupervisedAttemptResources(plan.resourceId, options);
    recordSupervisedAttemptLauncherJoined(plan.resourceId, options);
    expect(await closeSupervisedAttemptResources(plan.resourceId, options)).toBe(true);
  };
  return { options, expected, plan, oldHead, close };
}
function records(f: Awaited<ReturnType<typeof fixture>>) {
  return readSupervisedWorkflow((db) => {
    const sql = getNodeSqliteKysely<DB>(db);
    return {
      candidate: executeSqliteQueryTakeFirstSync(
        db,
        sql
          .selectFrom("task_flow_attempt_candidates")
          .selectAll()
          .where("resource_id", "=", f.plan.resourceId),
      ),
      draft: executeSqliteQueryTakeFirstSync(
        db,
        sql
          .selectFrom("task_flow_workspace_allocations")
          .selectAll()
          .where("allocation_id", "=", f.plan.allocationId),
      ),
    };
  }, f.options)!;
}
async function sealed(
  decision: SupervisedDecision = success,
  mode: Parameters<typeof fixture>[1] = "artifact",
) {
  const f = await fixture(decision, mode);
  await stageSupervisedAttemptCandidate(f.plan.resourceId, f.options);
  await f.close();
  return f;
}
function disposition(
  marker: Awaited<ReturnType<typeof acceptSupervisedAttemptCandidate>>,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const result = consumeSupervisedAttemptSettlement(marker, f.expected);
  expect(result).toBeDefined();
  return result!;
}

it("replays concurrent acceptance inside the transaction, not after stale source assertions", async () => {
  const f = await sealed();
  let entered = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  controls.verify.mockImplementation(async () => {
    if (++entered === 2) {
      release();
    }
    await gate;
  });
  const results = await Promise.all([
    acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
    acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
  ]);
  const [first, second] = results.map((result) => disposition(result, f));
  expect(first).toEqual(second);
  expect(first.endpoint?.kind).toBe("succeeded");
  expect(first.revision).toBe(f.expected.revision + 1);
  expect(records(f).draft?.state).toBe("released");
  expect(records(f).candidate?.state).toBe("consumed");
});
it("returns the consumed disposition after a lost response without overwriting a successor", async () => {
  const f = await sealed({ kind: "continue", next: "Inspect the accepted output" });
  const first = disposition(
    await acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
    f,
  );
  const successor = claimSupervisedTask(f.expected.flowId, "owner", Date.now(), f.options);
  expect(successor).toBeDefined();
  const head = getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options);
  const replay = disposition(
    await acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
    f,
  );
  expect(replay).toEqual(first);
  expect(getSupervisedTask(f.expected.flowId, f.options)).toEqual(successor);
  expect(getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)).toEqual(
    head,
  );
});
it.each([
  {
    kind: "operation",
    operation: { key: "unauthorized", kind: "command", profile: "not-accepted", input: {} },
  },
  {
    kind: "define_goal",
    goal: {
      objective: "Replace the accepted goal",
      success: [{ id: "other", description: "A different target" }],
      partial: [],
    },
  },
] satisfies SupervisedDecision[])(
  "rolls back version, task, release and consumed receipt for invalid $kind",
  async (decision) => {
    const f = await sealed(decision);
    const before = records(f);
    await expect(
      acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
    ).rejects.toThrow();
    expect(records(f)).toEqual(before);
    expect(getSupervisedTask(f.expected.flowId, f.options)).toEqual(f.expected);
    expect(getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)).toEqual(
      f.oldHead,
    );
    expect(listSupervisedOperations(f.options, f.expected.flowId, f.expected.episode)).toEqual([]);
  },
);
it("revalidates source after real verifier awaits without installing cancelled output", async () => {
  const f = await sealed();
  controls.verify.mockImplementationOnce(async () => {
    cancelSupervisedTask(f.expected.flowId, Date.now(), f.options);
  });
  await expect(
    acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
  ).rejects.toThrow();
  expect(getSupervisedTask(f.expected.flowId, f.options)?.endpoint?.kind).toBe("cancelled");
  expect(getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)).toEqual(
    f.oldHead,
  );
  expect(records(f).candidate?.state).toBe("sealed");
});
it("rejects changed candidate bytes before semantic settlement", async () => {
  const f = await sealed();
  const version = records(f).candidate?.version_id;
  expect(version).toBeTruthy();
  const file = path.join(supervisedWorkspaceVersionPath(version!, f.options), "answer.txt");
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, "changed\n");
  await expect(
    acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
  ).rejects.toThrow(/bytes changed/);
  expect(getSupervisedTask(f.expected.flowId, f.options)).toEqual(f.expected);
  expect(getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)).toEqual(
    f.oldHead,
  );
});
it("does not accept a staged decision without seal or a sealed candidate without physical closure", async () => {
  const f = await fixture();
  await expect(
    acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
  ).rejects.toThrow(/sealing and physical/);
  await stageSupervisedAttemptCandidate(f.plan.resourceId, f.options);
  await expect(
    acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
  ).rejects.toThrow(/sealing and physical/);
  expect(getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)).toEqual(
    f.oldHead,
  );
});
it("requires actual scope membership even for the exact custodian PID", async () => {
  const f = await fixture();
  controls.member.mockImplementationOnce(() => {
    throw new Error("Custodian left its scope");
  });
  await expect(stageSupervisedAttemptCandidate(f.plan.resourceId, f.options)).rejects.toThrow(
    /left its scope/,
  );
  expect(records(f).candidate?.state).toBe("decision");
});
it("atomically adopts proposed bytes and schedules a missing acceptance check", async () => {
  const f = await sealed(success, "receipts");
  const result = disposition(
    await acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
    f,
  );
  expect(result.endpoint).toBeNull();
  const operations = listSupervisedOperations(f.options, f.expected.flowId, f.expected.episode);
  expect(operations).toHaveLength(1);
  expect(operations[0]?.request.profile).toBe("check");
  expect(
    getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)?.version_id,
  ).toBe(records(f).candidate?.version_id);
  expect(records(f).candidate?.settled_task_json).toBe(JSON.stringify(result));
});
it("retains the exact candidate and scratch for operator acceptance instead of inventing success", async () => {
  const f = await sealed(success, "operator");
  expect(f.oldHead).toBeDefined();
  controlSupervisedTask(
    {
      flowId: f.expected.flowId,
      episode: f.expected.episode,
      revision: f.expected.revision,
      inputId: "approve-prior-artifact",
      action: { kind: "approve", sourceHash: f.oldHead!.source_hash, criterionIds: ["correct"] },
    },
    { actorId: "operator", assertCurrent: () => {} },
    Date.now(),
    f.options,
  );
  const result = disposition(
    await acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options),
    f,
  );
  expect(result.endpoint?.kind).toBe("input_required");
  expect(records(f).draft?.state).toBe("released");
  expect(records(f).draft?.discardable_at_ms).toBeNull();
  expect(
    getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options)?.version_id,
  ).toBe(records(f).candidate?.version_id);
});
it("releases universal workflowless allocation without installing a workspace version", async () => {
  const f = await sealed({ kind: "continue", next: "Continue reasoning" }, "none");
  disposition(await acceptSupervisedAttemptCandidate(f.expected, f.plan.resourceId, f.options), f);
  expect(records(f).draft?.state).toBe("released");
  expect(records(f).draft?.discardable_at_ms).toBe(Date.now());
  expect(records(f).candidate?.version_id).toBeNull();
  expect(
    getSupervisedWorkspaceHead(f.expected.flowId, f.expected.episode, f.options),
  ).toBeUndefined();
});
