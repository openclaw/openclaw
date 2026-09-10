import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  bindSupervisedCommandResources,
  getSupervisedCommandResources,
  startSupervisedCommandTransport,
  recordSupervisedCommandTransportExtinct,
  planSupervisedCommandResources,
  recordSupervisedCommandResourcesClosed,
  sealSupervisedCommandPlan,
  recordSealedSupervisedCommandClosed,
} from "./supervised-command-custody.js";
import {
  supervisedCommandScopeName,
  type SupervisedCommandScopeIdentity,
} from "./supervised-command-resources.js";
import {
  MAX_SUPERVISED_OPERATION_PROCESSES,
  observeSupervisedOperationProcess,
  reconcileSupervisedOperationCapacity,
} from "./supervised-operation.capacity.js";
import { runSupervisedCommand } from "./supervised-operation.command.js";
import {
  assertSupervisedOperationCurrent,
  bindSupervisedOperationProcess,
  claimSupervisedOperation,
  enqueueSupervisedOperation,
  getSupervisedOperation,
  getSupervisedOperationExecution,
  recordSupervisedOperationOutcome,
  reserveSupervisedOperationDispatch,
} from "./supervised-operation.store.js";
import {
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
} from "./supervised-task.store.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";

const dirs = createTempDirTracker();

function admitted(root = dirs.make("openclaw-command-custody-"), flowId = "work") {
  mkdirSync(`${root}/workspace-${flowId}`, { recursive: true });
  const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
  const goal = {
    objective: "Check the accepted program",
    success: [{ id: "correct", description: "Host behavioral check passes" }],
    partial: [],
  };
  const workflow = encodeSupervisedWorkflowContract(
    {
      version: 1,
      workspace: `${root}/workspace-${flowId}`,
      profiles: [
        {
          kind: "command",
          id: "check",
          executable: process.execPath,
          // Store-only fixture: this profile is never executed.
          executableSha256: "0".repeat(64),
          argv: ["--version"],
          timeoutMs: 1000,
        },
      ],
      acceptance: [{ kind: "receipts", criterionId: "correct", profiles: ["check"] }],
    },
    goal,
  ).contract;
  heartbeatTaskSupervisor("coordinator", 1000, 10_000, options);
  const task = createSupervisedTask(
    {
      flowId,
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Check it",
      goal,
      policy: { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
      workflow,
    },
    "coordinator",
    1000,
    options,
  );
  const claimedTask = claimSupervisedTask(task.flowId, "coordinator", 1000, options);
  if (!claimedTask) {
    throw new Error("Fixture task was not claimed");
  }
  const expected = reserveSupervisedDispatch(claimedTask, 1000, options);
  const operation = enqueueSupervisedOperation(
    expected,
    { key: "check-1", kind: "command", profile: "check", input: {} },
    1001,
    options,
  );
  return { root, options, task, operation };
}

function claimed() {
  const f = admitted();
  const execution = claimSupervisedOperation(f.operation.operationId, "runner", 1002, f.options);
  if (!execution) {
    throw new Error("Fixture operation was not claimed");
  }
  return { ...f, execution };
}

/** Synthetic kernel observation tests the SQL binding contract only. No systemd
 * scope is created, and these tests do not establish actual kernel extinction. */
function identity(executionId: string): SupervisedCommandScopeIdentity {
  const scopeName = supervisedCommandScopeName(executionId);
  return {
    executionId,
    scopeName,
    invocationId: "a".repeat(32),
    controlGroup: `/user.slice/user-1000.slice/user@1000.service/app.slice/${scopeName}`,
    bootId: "ba72521b-a318-46de-9a45-6895e5bc4cdf",
    hostId: "c".repeat(64),
    custodian: { pid: 321, startTime: 100 },
    cgroupDevice: "27",
    cgroupInode: "42",
    limits: { memoryBytes: 1024 * 1024 * 1024, tasks: 128 },
  };
}

afterEach(() => {
  vi.useRealTimers();
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe("durable command resource custody", () => {
  it.skipIf(process.platform !== "linux").each(["aliased", "non-private"] as const)(
    "rejects a %s command artifact root before creating any directory within it",
    async (kind) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(1003);
      const f = claimed();
      const artifactRoot = path.dirname(supervisedWorkspaceVersionPath(randomUUID(), f.options));
      const target = kind === "aliased" ? `${f.root}/outside` : artifactRoot;
      await fs.mkdir(target, { mode: 0o700 });
      if (kind === "aliased") {
        await fs.symlink(target, artifactRoot, "dir");
      } else {
        await fs.chmod(target, 0o755);
      }
      await fs.writeFile(`${target}/keep`, "operator-owned");

      // Real SQL reservation and filesystem boundary. This store-only fixture
      // has no pinned command input, so even the broken path cannot launch a
      // kernel scope; its later context rejection must not hide an earlier write.
      const error: unknown = await runSupervisedCommand({
        execution: f.execution,
        options: f.options,
        signal: new AbortController().signal,
        assertCurrent: () => assertSupervisedOperationCurrent(f.execution, Date.now(), f.options),
      }).catch((caught: unknown) => caught);

      // Inspect the actual destination before checking the rejection reason.
      expect(await fs.readdir(target)).toEqual(["keep"]);
      expect(await fs.readFile(`${target}/keep`, "utf8")).toBe("operator-owned");
      expect(error).toMatchObject({
        message: expect.stringMatching(/canonical private directory/),
      });
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toBeUndefined();
    },
  );

  it("cannot plan resources after payload dispatch was reserved", () => {
    const f = claimed();
    reserveSupervisedOperationDispatch(f.execution, 1003, f.options);
    expect(() => planSupervisedCommandResources(f.execution, 1004, f.options)).toThrow(
      /before payload dispatch/,
    );
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toBeUndefined();
  });

  it("seals an unbound plan against late admission without confusing the seal with extinction", () => {
    const f = claimed();
    bindSupervisedOperationProcess(
      f.execution,
      requireNodeWorkerProcessIdentity(process.pid),
      1003,
      f.options,
    );
    planSupervisedCommandResources(f.execution, 1004, f.options);
    expect(() => recordSealedSupervisedCommandClosed(f.execution, 1005, f.options)).toThrow(
      /not sealed/,
    );
    startSupervisedCommandTransport(f.execution, 1005, f.options);
    recordSupervisedCommandTransportExtinct(f.execution, 1005, f.options);
    expect(sealSupervisedCommandPlan(f.execution, 1006, f.options)).toBe(true);
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("sealed");
    expect(() =>
      bindSupervisedCommandResources(
        f.execution,
        identity(f.execution.executionId),
        1007,
        f.options,
      ),
    ).toThrow(/consumed/);
    // Store-only observation: real transport extinction is tested through the
    // independent process boundary, not inferred by this fixture.
    recordSealedSupervisedCommandClosed(f.execution, 1008, f.options);
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("closed");
    expect(getSupervisedOperation(f.operation.operationId, f.options)?.outcome).toBeNull();
  });

  it("does not let a different process close the original launch plan", () => {
    const f = claimed();
    const current = requireNodeWorkerProcessIdentity(process.pid);
    bindSupervisedOperationProcess(
      f.execution,
      { ...current, startTime: current.startTime + 1 },
      1003,
      f.options,
    );
    planSupervisedCommandResources(f.execution, 1004, f.options);
    expect(() => sealSupervisedCommandPlan(f.execution, 1005, f.options)).toThrow(
      /another process owner/,
    );
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
      "planned",
    );
  });
  it("persists a pre-dispatch launch plan and rejects relaunch after reopening the store", () => {
    const f = claimed();
    planSupervisedCommandResources(f.execution, 1003, f.options);
    const before = getSupervisedCommandResources(f.execution.executionId, f.options);
    expect(before).toMatchObject({ state: "planned", identity: null });
    expect(getSupervisedOperationExecution(f.execution.executionId, f.options)).toMatchObject({
      dispatchedAt: null,
      outcome: null,
    });
    closeOpenClawStateDatabaseForTest();
    expect(() => planSupervisedCommandResources(f.execution, 1004, f.options)).toThrow(
      /reconcile instead of relaunching/,
    );
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toEqual(before);
  });

  it("binds one exact observation only to its previously reserved execution", () => {
    const f = claimed();
    const observed = identity(f.execution.executionId);
    expect(() => bindSupervisedCommandResources(f.execution, observed, 1003, f.options)).toThrow();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toBeUndefined();
    planSupervisedCommandResources(f.execution, 1004, f.options);
    expect(() =>
      bindSupervisedCommandResources(f.execution, identity(randomUUID()), 1005, f.options),
    ).toThrow(/does not match/);
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
      "planned",
    );
    bindSupervisedCommandResources(f.execution, observed, 1006, f.options);
    const before = getSupervisedCommandResources(f.execution.executionId, f.options);
    expect(before).toMatchObject({ state: "bound", identity: observed });
    for (const replay of [observed, { ...observed, invocationId: "b".repeat(32) }]) {
      expect(() => bindSupervisedCommandResources(f.execution, replay, 1007, f.options)).toThrow(
        /already consumed/,
      );
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toEqual(before);
    }
  });

  it.each(["cancelled", "expired"] as const)(
    "cannot bind an observation after execution authority is %s",
    (cause) => {
      const f = claimed();
      planSupervisedCommandResources(f.execution, 1003, f.options);
      const before = getSupervisedCommandResources(f.execution.executionId, f.options);
      if (cause === "cancelled") {
        cancelSupervisedTask(f.task.flowId, 1004, f.options);
      }
      const now = cause === "expired" ? f.execution.leaseExpiresAt : 1005;
      expect(() =>
        bindSupervisedCommandResources(
          f.execution,
          identity(f.execution.executionId),
          now,
          f.options,
        ),
      ).toThrow(/no longer/);
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toEqual(before);
    },
  );

  it("records exact late closure without changing the cancelled task or immutable operation receipt", () => {
    const f = claimed();
    const observed = identity(f.execution.executionId);
    planSupervisedCommandResources(f.execution, 1003, f.options);
    bindSupervisedCommandResources(f.execution, observed, 1004, f.options);
    reserveSupervisedOperationDispatch(f.execution, 1005, f.options);
    cancelSupervisedTask(f.task.flowId, 1006, f.options);
    recordSupervisedOperationOutcome(
      f.execution,
      { status: "failed", summary: "Payload stopped", facts: { exitCode: "1" }, artifacts: [] },
      1007,
      f.options,
    );
    const task = getSupervisedTask(f.task.flowId, f.options);
    const operation = getSupervisedOperation(f.operation.operationId, f.options);
    const execution = getSupervisedOperationExecution(f.execution.executionId, f.options);
    closeOpenClawStateDatabaseForTest();
    recordSupervisedCommandResourcesClosed(observed, 20_000, f.options);
    const closed = getSupervisedCommandResources(f.execution.executionId, f.options);
    expect(closed).toMatchObject({ state: "closed", identity: observed, updated_at_ms: 20_000 });
    recordSupervisedCommandResourcesClosed(observed, 20_001, f.options);
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toEqual(closed);
    expect(getSupervisedTask(f.task.flowId, f.options)).toEqual(task);
    expect(getSupervisedOperation(f.operation.operationId, f.options)).toEqual(operation);
    expect(getSupervisedOperationExecution(f.execution.executionId, f.options)).toEqual(execution);
    expect(() => assertSupervisedOperationCurrent(f.execution, 20_002, f.options)).toThrow();
    expect(() => reserveSupervisedOperationDispatch(f.execution, 20_002, f.options)).toThrow();
  });

  it("rejects unbound and mismatched closure observations without releasing the accepted resource", () => {
    const f = claimed();
    const observed = identity(f.execution.executionId);
    planSupervisedCommandResources(f.execution, 1003, f.options);
    expect(() => recordSupervisedCommandResourcesClosed(observed, 1004, f.options)).toThrow(
      /exact accepted resource binding/,
    );
    bindSupervisedCommandResources(f.execution, observed, 1005, f.options);
    const before = getSupervisedCommandResources(f.execution.executionId, f.options);
    const mismatches: SupervisedCommandScopeIdentity[] = [
      identity(randomUUID()),
      { ...observed, invocationId: "b".repeat(32) },
      { ...observed, bootId: randomUUID() },
      { ...observed, controlGroup: `${observed.controlGroup}-replacement` },
      { ...observed, cgroupDevice: "28" },
      { ...observed, cgroupInode: "43" },
      { ...observed, custodian: { ...observed.custodian, startTime: 101 } },
      { ...observed, limits: { ...observed.limits, tasks: 256 } },
    ];
    for (const mismatch of mismatches) {
      expect(() => recordSupervisedCommandResourcesClosed(mismatch, 1006, f.options)).toThrow(
        /exact accepted resource binding/,
      );
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)).toEqual(before);
    }
  });

  it.each(["planned", "bound"] as const)(
    "retains physical capacity after runner death with %s resources until exact closure",
    (state) => {
      const root = dirs.make("openclaw-command-resource-capacity-");
      const launcher = requireNodeWorkerProcessIdentity(process.pid);
      const items = Array.from({ length: MAX_SUPERVISED_OPERATION_PROCESSES + 1 }, (_, index) =>
        admitted(root, `task-${index}`),
      );
      const executions = items.slice(0, -1).map((item) => {
        const execution = claimSupervisedOperation(
          item.operation.operationId,
          "runner",
          1002,
          item.options,
          launcher,
        );
        if (!execution) {
          throw new Error("Fixture failed to reserve physical capacity");
        }
        return execution;
      });
      const first = executions[0];
      const next = items.at(-1);
      if (!first || !next) {
        throw new Error("Capacity fixture is incomplete");
      }
      const observed = identity(first.executionId);
      planSupervisedCommandResources(first, 1003, next.options);
      if (state === "bound") {
        bindSupervisedCommandResources(first, observed, 1004, next.options);
      }
      // Real PID inspection classifies this deliberately different birth identity
      // as reused. No child process or scope is launched by this store test.
      observeSupervisedOperationProcess(
        first.executionId,
        { ...launcher, startTime: launcher.startTime + 1 },
        1005,
        next.options,
      );
      closeOpenClawStateDatabaseForTest();
      reconcileSupervisedOperationCapacity(1006, next.options);
      const claimNext = () =>
        claimSupervisedOperation(next.operation.operationId, "next", 1007, next.options, launcher);
      expect(claimNext).toThrow(/capacity exhausted/);
      expect(getSupervisedOperation(next.operation.operationId, next.options)).toMatchObject({
        state: "queued",
        generation: 0,
      });
      if (state === "planned") {
        expect(() =>
          recordSupervisedCommandResourcesClosed(observed, 1008, next.options),
        ).toThrow();
        expect(claimNext).toThrow(/capacity exhausted/);
        bindSupervisedCommandResources(first, observed, 1009, next.options);
      }
      recordSupervisedCommandResourcesClosed(observed, 1010, next.options);
      reconcileSupervisedOperationCapacity(1011, next.options);
      expect(
        claimSupervisedOperation(next.operation.operationId, "next", 1012, next.options, launcher),
      ).toMatchObject({ generation: 1 });
      expect(getSupervisedOperationExecution(first.executionId, next.options)?.outcome).toBeNull();
      expect(getSupervisedOperation(first.operationId, next.options)?.state).toBe("running");
    },
  );
});
