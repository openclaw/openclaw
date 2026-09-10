import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  assertSupervisedAttemptPayloadCurrent,
  assertSupervisedAttemptResourcesCurrent,
  readSupervisedAttemptContext,
  beginSupervisedAttemptLaunch,
  bindSupervisedAttemptResources,
  closeSupervisedAttemptResources,
  getSupervisedAttemptResources,
  recordSupervisedAttemptLauncherJoined,
  reserveSupervisedAttemptPayload,
  reserveSupervisedAttemptResources,
  revokeSupervisedAttemptResources,
} from "./supervised-attempt-custody.js";
import {
  assertSupervisedAttemptCleanupCurrent,
  claimSupervisedAttemptCleanup,
} from "./supervised-attempt-recovery.js";
import {
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
} from "./supervised-task.store.js";
import { readSupervisedWorkflow } from "./supervised-workflow.persistence.js";

const kernel = vi.hoisted(() => ({
  inspect: vi.fn(),
  closed: vi.fn(),
  absent: vi.fn(),
  member: vi.fn(),
}));
// Real SQLite and task ownership; kernel observations alone are simulated.
// These tests make no claim that a systemd scope was actually created.
vi.mock("./supervised-process-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervised-process-resources.js")>()),
  supervisedProcessScopeName: (id: string) => `openclaw-task-${id}.scope`,
  readSupervisedProcessHostIdentity: () => ({
    hostId: "a".repeat(64),
    bootId: "e1b0a23e-26d8-4ee6-ac6c-e67a10cc5c99",
  }),
  validateSupervisedProcessResourceLimits: () => {},
  inspectSupervisedProcessScope: kernel.inspect,
  isSupervisedProcessScopeClosed: kernel.closed,
  isSealedSupervisedProcessScopeAbsent: kernel.absent,
  assertSupervisedProcessScopeMember: kernel.member,
  terminateSupervisedProcessScope: vi.fn(),
}));
const dirs = createTempDirTracker();
const limits = { memoryBytes: 2 * 1024 ** 3, tasks: 128 };
function fixture() {
  const options = { env: { OPENCLAW_STATE_DIR: dirs.make("attempt-custody-") } };
  const now = Date.now();
  heartbeatTaskSupervisor("owner", now, 60_000, options);
  const task = createSupervisedTask(
    {
      flowId: "attempt-test",
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Reason about a bounded request",
      goal: {
        objective: "Answer",
        success: [{ id: "answer", description: "Answer is provided" }],
        partial: [],
      },
      policy: { deadlineAt: now + 300_000, maxAttempts: 4, attemptTimeoutMs: 60_000 },
    },
    "owner",
    now,
    options,
  );
  const claim = claimSupervisedTask(task.flowId, "owner", now, options);
  if (!claim) {
    throw new Error("Fixture claim failed");
  }
  const dispatched = reserveSupervisedDispatch(claim, now, options);
  const plan = reserveSupervisedAttemptResources(dispatched, limits, options);
  return { options, dispatched, plan };
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-09T20:00:00Z"));
  kernel.closed.mockReset().mockResolvedValue(false);
  kernel.absent.mockReset().mockResolvedValue(true);
  kernel.member.mockReset();
  kernel.inspect.mockReset().mockImplementation(async ({ resourceId, limits: boundLimits }) => ({
    resourceId,
    scopeName: `openclaw-task-${resourceId}.scope`,
    invocationId: "b".repeat(32),
    controlGroup: `/fixture/${resourceId}`,
    hostId: "a".repeat(64),
    bootId: "e1b0a23e-26d8-4ee6-ac6c-e67a10cc5c99",
    custodian: requireNodeWorkerProcessIdentity(process.pid),
    cgroupDevice: "25",
    cgroupInode: "100",
    limits: boundLimits,
  }));
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  dirs.cleanup();
});

describe("attempt resource custody", () => {
  it("reserves an exact private allocation even without a workflow", () => {
    const f = fixture();
    const context = readSupervisedAttemptContext(f.plan.resourceId, f.options);
    expect(f.plan.workspace).toBeNull();
    expect(context?.allocationRoot).toContain(f.plan.allocationId);
    expect(
      assertSupervisedAttemptResourcesCurrent(f.plan.resourceId, f.options).plan.storage,
    ).toEqual({ workingBytes: 128 * 1024 * 1024, workingInodes: 32768 });
  });
  it("rejects payload admission when the custodian has left the exact scope", async () => {
    const f = fixture();
    beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
    await bindSupervisedAttemptResources(f.plan.resourceId, f.options);
    kernel.member.mockImplementationOnce(() => {
      throw new Error("Host outside scope");
    });
    expect(() => reserveSupervisedAttemptPayload(f.plan.resourceId, f.options)).toThrow(
      /outside scope/,
    );
    expect(getSupervisedAttemptResources(f.plan.resourceId, f.options)?.state).toBe("bound");
  });
  it("consumes reservation and launch once, including after an uncertain launch", () => {
    const f = fixture();
    expect(() => reserveSupervisedAttemptResources(f.dispatched, limits, f.options)).toThrow(
      /already reserved/,
    );
    beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
    expect(() => beginSupervisedAttemptLaunch(f.plan.resourceId, f.options)).toThrow(
      /already consumed/,
    );
    expect(getSupervisedAttemptResources(f.plan.resourceId, f.options)?.state).toBe("launching");
  });
  it("rechecks cancellation after awaited kernel inspection before binding", async () => {
    const f = fixture();
    beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
    const inspect = kernel.inspect.getMockImplementation()!;
    kernel.inspect.mockImplementationOnce(async (args) => {
      const identity = await inspect(args);
      cancelSupervisedTask(f.dispatched.flowId, Date.now(), f.options);
      return identity;
    });
    await expect(bindSupervisedAttemptResources(f.plan.resourceId, f.options)).rejects.toThrow(
      /no longer owns/,
    );
    expect(getSupervisedAttemptResources(f.plan.resourceId, f.options)?.identity).toBeNull();
  });
  it("requires the tool-serving host to be in the bound scope and consumes payload once", async () => {
    const f = fixture();
    beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
    await bindSupervisedAttemptResources(f.plan.resourceId, f.options);
    expect(() => assertSupervisedAttemptPayloadCurrent(f.plan.resourceId, f.options)).toThrow(
      /not active/,
    );
    reserveSupervisedAttemptPayload(f.plan.resourceId, f.options);
    expect(() => reserveSupervisedAttemptPayload(f.plan.resourceId, f.options)).toThrow(
      /already reserved/,
    );
    kernel.member.mockClear();
    kernel.member.mockImplementationOnce(() => {
      throw new Error("Host outside scope");
    });
    expect(() => assertSupervisedAttemptPayloadCurrent(f.plan.resourceId, f.options)).toThrow(
      /outside scope/,
    );
    expect(kernel.member).toHaveBeenCalledOnce();
  });
  it("holds a cancelled bound resource until kernel extinction is observed", async () => {
    const f = fixture();
    beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
    await bindSupervisedAttemptResources(f.plan.resourceId, f.options);
    reserveSupervisedAttemptPayload(f.plan.resourceId, f.options);
    cancelSupervisedTask(f.dispatched.flowId, Date.now(), f.options);
    revokeSupervisedAttemptResources(f.plan.resourceId, f.options);
    recordSupervisedAttemptLauncherJoined(f.plan.resourceId, f.options);
    expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(false);
    kernel.closed.mockResolvedValueOnce(true);
    expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(true);
    expect(getSupervisedAttemptResources(f.plan.resourceId, f.options)?.state).toBe("closed");
  });
  it("does not equate an absent unit with a joined uncertain launcher", async () => {
    const f = fixture();
    beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
    revokeSupervisedAttemptResources(f.plan.resourceId, f.options);
    expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(false);
    expect(kernel.absent).not.toHaveBeenCalled();
    recordSupervisedAttemptLauncherJoined(f.plan.resourceId, f.options);
    expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(true);
  });
  it("can close a revoked never-launched plan without fabricating a join", async () => {
    const f = fixture();
    revokeSupervisedAttemptResources(f.plan.resourceId, f.options);
    expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(true);
    expect(
      getSupervisedAttemptResources(f.plan.resourceId, f.options)?.launcher_joined_at_ms,
    ).toBeNull();
  });
  it("never grants cleanup against a current authorized attempt", () => {
    const f = fixture();
    expect(claimSupervisedAttemptCleanup(f.plan.resourceId, "owner", f.options)).toBeNull();
  });
  it("fences an expired cleanup claim after replacement even with the same owner", () => {
    const f = fixture();
    revokeSupervisedAttemptResources(f.plan.resourceId, f.options);
    const first = claimSupervisedAttemptCleanup(f.plan.resourceId, "owner", f.options);
    if (!first) {
      throw new Error("Cleanup claim missing");
    }
    vi.setSystemTime(Date.now() + 30_001);
    heartbeatTaskSupervisor("owner", Date.now(), 60_000, f.options);
    const second = claimSupervisedAttemptCleanup(f.plan.resourceId, "owner", f.options);
    if (!second) {
      throw new Error("Replacement cleanup claim missing");
    }
    expect(first.owner.nonce).not.toBe(second.owner.nonce);
    expect(() => assertSupervisedAttemptCleanupCurrent(first, f.options)).toThrow(
      /no longer current/,
    );
    expect(assertSupervisedAttemptCleanupCurrent(second, f.options).resource_id).toBe(
      f.plan.resourceId,
    );
  });
});

it("releases only the exact closed draft while the launcher remains alive, without discarding evidence", async () => {
  const f = fixture();
  const allocation = () =>
    readSupervisedWorkflow(
      (db) =>
        executeSqliteQueryTakeFirstSync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_workspace_allocations")
            .selectAll()
            .where("allocation_id", "=", f.plan.allocationId),
        ),
      f.options,
    )!;
  beginSupervisedAttemptLaunch(f.plan.resourceId, f.options);
  await bindSupervisedAttemptResources(f.plan.resourceId, f.options);
  revokeSupervisedAttemptResources(f.plan.resourceId, f.options);
  recordSupervisedAttemptLauncherJoined(f.plan.resourceId, f.options);
  expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(false);
  expect(allocation().state).toBe("reserved");
  kernel.closed.mockResolvedValue(true);
  expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(true);
  expect(allocation()).toMatchObject({
    state: "released",
    owner_pid: process.pid,
    discardable_at_ms: null,
  });
  expect(await closeSupervisedAttemptResources(f.plan.resourceId, f.options)).toBe(true);
  expect(allocation().discardable_at_ms).toBeNull();
});
