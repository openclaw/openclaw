import { mkdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  bindSupervisedCommandResources,
  getSupervisedCommandResources,
  startSupervisedCommandTransport,
  recordSupervisedCommandTransportExtinct,
  planSupervisedCommandResources,
  recordSupervisedCommandResourcesClosed,
} from "./supervised-command-custody.js";
import { reconcileSupervisedCommandResources } from "./supervised-command-recovery.js";
import type { SupervisedCommandScopeIdentity } from "./supervised-command-resources.js";
import {
  observeSupervisedOperationProcess,
  reconcileSupervisedOperationCapacity,
} from "./supervised-operation.capacity.js";
import {
  claimSupervisedOperation,
  bindSupervisedOperationProcess,
  enqueueSupervisedOperation,
  getSupervisedOperation,
  getSupervisedOperationExecution,
  markSupervisedOperationReconciling,
  recordSupervisedOperationOutcome,
  reserveSupervisedOperationDispatch,
  resolveSupervisedOperationReconciliation,
} from "./supervised-operation.store.js";
import {
  cancelSupervisedTask,
  claimSupervisedTask,
  createSupervisedTask,
  getSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
} from "./supervised-task.store.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
} from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";

// Real SQLite/operation/task state, synthetic kernel observations only. No unit
// or process is created; actual systemd behavior belongs to the resource proof.
const kernel = vi.hoisted(() => ({
  host: vi.fn<() => { hostId: string; bootId: string }>(),
  absent: vi.fn<() => Promise<boolean>>(),
  closed: vi.fn<(identity: SupervisedCommandScopeIdentity) => Promise<boolean>>(),
  terminate:
    vi.fn<(identity: SupervisedCommandScopeIdentity, assertCurrent: () => void) => Promise<void>>(),
  process: vi.fn<() => "live" | "dead" | "reused" | "unknown">(),
}));
vi.mock("./supervised-command-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervised-command-resources.js")>()),
  isSupervisedCommandScopeClosed: kernel.closed,
  isSealedSupervisedCommandScopeAbsent: kernel.absent,
  terminateSupervisedCommandScope: kernel.terminate,
}));
vi.mock("./supervised-process-resources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supervised-process-resources.js")>()),
  readSupervisedProcessHostIdentity: kernel.host,
}));
vi.mock("../node-host/node-worker-process-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../node-host/node-worker-process-identity.js")>()),
  inspectNodeWorkerProcessIdentity: kernel.process,
}));
const dirs = createTempDirTracker();
const launcher = { pid: 312, startTime: 100 };

function fixture(root = dirs.make("openclaw-resource-recovery-"), flowId = "work", bind = true) {
  mkdirSync(`${root}/workspace-${flowId}`, { recursive: true });
  const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
  const goal = {
    objective: "Check a program",
    success: [{ id: "correct", description: "Host check passes" }],
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
  createSupervisedTask(
    {
      flowId,
      agentId: "poc",
      runtime: "codex",
      model: "openai/test",
      prompt: "Check it",
      goal,
      policy: { deadlineAt: 1_000_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
      workflow,
    },
    "coordinator",
    1000,
    options,
  );
  const task = claimSupervisedTask(flowId, "coordinator", 1000, options);
  if (!task) {
    throw new Error("Fixture task not claimed");
  }
  const attempt = reserveSupervisedDispatch(task, 1000, options);
  const operation = enqueueSupervisedOperation(
    attempt,
    { key: "check-1", kind: "command", profile: "check", input: {} },
    1001,
    options,
  );
  const execution = claimSupervisedOperation(
    operation.operationId,
    "runner",
    1002,
    options,
    launcher,
  );
  if (!execution) {
    throw new Error("Fixture operation not claimed");
  }
  observeSupervisedOperationProcess(execution.executionId, launcher, 1003, options);
  planSupervisedCommandResources(execution, 1004, options);
  const identity: SupervisedCommandScopeIdentity = {
    executionId: execution.executionId,
    scopeName: `openclaw-task-${execution.executionId}.scope`,
    invocationId: "a".repeat(32),
    controlGroup: `/app.slice/${execution.executionId}`,
    hostId: "b".repeat(64),
    bootId: "ba72521b-a318-46de-9a45-6895e5bc4cdf",
    custodian: { pid: 313, startTime: 200 },
    cgroupDevice: "27",
    cgroupInode: "42",
    limits: { memoryBytes: 1024 ** 3, tasks: 128 },
  };
  if (bind) {
    bindSupervisedCommandResources(execution, identity, 1005, options);
    reserveSupervisedOperationDispatch(execution, 1006, options);
  }
  const onError = vi.fn();
  const sweep = (afterExecutionId?: string, onlyFlowId?: string) =>
    reconcileSupervisedCommandResources({
      options,
      ownerId: "supervisor",
      assertCleanupCurrent: () => {},
      onError,
      afterExecutionId,
      onlyFlowId,
    });
  return { root, flowId, options, operation, execution, identity, sweep, onError };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(2000);
  kernel.host
    .mockReset()
    .mockReturnValue({ hostId: "b".repeat(64), bootId: "ba72521b-a318-46de-9a45-6895e5bc4cdf" });
  kernel.absent.mockReset().mockResolvedValue(true);
  kernel.closed.mockReset().mockResolvedValue(false);
  kernel.terminate.mockReset().mockImplementation(async (_identity, assertCurrent) => {
    assertCurrent();
  });
  kernel.process.mockReset().mockReturnValue("live");
});
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
  vi.useRealTimers();
});

describe("independent command resource recovery", () => {
  it("revisits a transient failure after a terminal receipt and frees only physical capacity", async () => {
    const f = fixture();
    kernel.closed.mockRejectedValueOnce(new Error("manager unavailable"));
    await f.sweep();
    expect(f.onError).toHaveBeenCalledTimes(1);
    const endpoint = cancelSupervisedTask(f.flowId, 2001, f.options);
    recordSupervisedOperationOutcome(
      f.execution,
      { status: "input_required", summary: "Cleanup uncertain" },
      2002,
      f.options,
    );
    const operation = getSupervisedOperation(f.operation.operationId, f.options);
    const observation = getSupervisedOperationExecution(f.execution.executionId, f.options);
    kernel.process.mockReturnValue("dead");
    reconcileSupervisedOperationCapacity(2003, f.options);
    const launchState = () =>
      readSupervisedWorkflow(
        (db) =>
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .selectFrom("task_flow_operation_launches")
              .select("state")
              .where("execution_id", "=", f.execution.executionId),
          ).rows[0]?.state,
        f.options,
      );
    expect(launchState()).toBe("spawned");
    closeOpenClawStateDatabaseForTest();
    kernel.closed.mockResolvedValue(true);
    await f.sweep();
    reconcileSupervisedOperationCapacity(2004, f.options);
    expect(launchState()).toBe("gone");
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("closed");
    expect(getSupervisedTask(f.flowId, f.options)).toEqual(endpoint);
    expect(getSupervisedOperation(f.operation.operationId, f.options)).toEqual(operation);
    expect(getSupervisedOperationExecution(f.execution.executionId, f.options)).toEqual(
      observation,
    );
    expect(kernel.terminate).not.toHaveBeenCalled();
  });

  it.each(["live", "unknown"] as const)("does not kill an authorized %s runner", async (state) => {
    const f = fixture();
    kernel.process.mockReturnValue(state);
    await f.sweep();
    expect(kernel.terminate).not.toHaveBeenCalled();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("bound");
    expect(f.onError).not.toHaveBeenCalled();
  });

  it.each(["dead", "reused"] as const)(
    "cleans a %s runner with live SQL lease under separate custody",
    async (state) => {
      const f = fixture();
      kernel.process.mockReturnValue(state);
      kernel.terminate.mockImplementation(async (_identity, assertCurrent) => {
        assertCurrent();
        kernel.closed.mockResolvedValue(true);
      });
      await f.sweep();
      expect(kernel.terminate).toHaveBeenCalledTimes(1);
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
        "closed",
      );
      expect(
        getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome,
      ).toBeNull();
    },
  );

  it.each(["cancelled", "lease expired"] as const)(
    "cleans populated resources after execution is %s without creating a receipt",
    async (reason) => {
      const f = fixture();
      if (reason === "cancelled") {
        cancelSupervisedTask(f.flowId, 2001, f.options);
      } else {
        vi.setSystemTime(122_000);
      }
      const task = getSupervisedTask(f.flowId, f.options);
      const operation = getSupervisedOperation(f.operation.operationId, f.options);
      kernel.terminate.mockImplementation(async (_identity, assertCurrent) => {
        assertCurrent();
        kernel.closed.mockResolvedValue(true);
      });
      await f.sweep();
      expect(kernel.terminate).toHaveBeenCalledTimes(1);
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
        "closed",
      );
      expect(getSupervisedTask(f.flowId, f.options)).toEqual(task);
      expect(getSupervisedOperation(f.operation.operationId, f.options)).toEqual(operation);
      expect(
        getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome,
      ).toBeNull();
    },
  );

  it.each(["lease expiry", "replacement owner", "external stop", "runner current again"] as const)(
    "rejects late signaling after %s while awaiting kernel inspection",
    async (loss) => {
      const f = fixture();
      kernel.process.mockReturnValue("dead");
      let externalCurrent = true;
      let release = () => {};
      let entered = () => {};
      const enteredPromise = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signal = vi.fn();
      kernel.terminate.mockImplementation(async (_identity, assertCurrent) => {
        assertCurrent();
        entered();
        await gate;
        assertCurrent();
        signal();
      });
      const run = reconcileSupervisedCommandResources({
        options: f.options,
        ownerId: "supervisor",
        onError: f.onError,
        assertCleanupCurrent: () => {
          if (!externalCurrent) {
            throw new Error("Supervisor stopped");
          }
        },
      });
      await enteredPromise;
      if (loss === "lease expiry") {
        vi.setSystemTime(32_001);
      }
      if (loss === "external stop") {
        externalCurrent = false;
      }
      if (loss === "runner current again") {
        kernel.process.mockReturnValue("live");
      }
      if (loss === "replacement owner") {
        writeSupervisedWorkflow(
          (db) =>
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .updateTable("task_flow_command_resources")
                .set({ cleanup_owner: "successor", cleanup_expires_at_ms: 99_000 })
                .where("execution_id", "=", f.execution.executionId),
            ),
          f.options,
        );
      }
      release();
      await run;
      expect(signal).not.toHaveBeenCalled();
      expect(f.onError).toHaveBeenCalledTimes(1);
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
        "bound",
      );
      if (loss === "replacement owner") {
        expect(
          getSupervisedCommandResources(f.execution.executionId, f.options)?.cleanup_owner,
        ).toBe("successor");
      }
    },
  );

  it("scans old generations without disturbing the replacement execution", async () => {
    const f = fixture();
    vi.setSystemTime(122_000);
    const pending = markSupervisedOperationReconciling(f.execution, Date.now(), f.options);
    recordSupervisedCommandResourcesClosed(f.identity, Date.now(), f.options);
    resolveSupervisedOperationReconciliation(
      pending,
      { retryAt: Date.now(), evidence: "Isolated check can replay" },
      Date.now(),
      f.options,
    );
    const replacement = claimSupervisedOperation(
      f.operation.operationId,
      "replacement",
      Date.now(),
      f.options,
    );
    expect(replacement?.generation).toBe(2);
    // Simulate a historical unresolved old-generation binding. Current replay
    // admission prevents this state; recovery still must inspect retained rows
    // rather than assuming every resource belongs to the latest generation.
    writeSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("task_flow_command_resources")
            .set({ state: "bound" })
            .where("execution_id", "=", f.execution.executionId),
        ),
      f.options,
    );
    const before = getSupervisedOperation(f.operation.operationId, f.options);
    kernel.terminate.mockImplementation(async (_identity, assertCurrent) => {
      assertCurrent();
      kernel.closed.mockResolvedValue(true);
    });
    await f.sweep();
    expect(kernel.terminate).toHaveBeenCalledWith(f.identity, expect.any(Function));
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("closed");
    expect(getSupervisedOperation(f.operation.operationId, f.options)).toEqual(before);
    expect(
      replacement && getSupervisedOperationExecution(replacement.executionId, f.options)?.outcome,
    ).toBeNull();
  });

  it("paginates past failures and respects foreground scope without retiring unknown launch plans", async () => {
    const root = dirs.make("openclaw-resource-pages-");
    const rows = Array.from({ length: 8 }, (_, i) => fixture(root, `bound-${i}`));
    // Existing capacity has eight entries; retire their synthetic runner slots
    // only for fixture setup before admitting a ninth operation.
    writeSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("task_flow_operation_launches")
            .set({ state: "gone" }),
        ),
      rows[0]!.options,
    );
    const ninth = fixture(root, "ninth");
    const planned = fixture(root, "planned", false);
    const order = [...rows, ninth].toSorted((a, b) =>
      a.execution.executionId.localeCompare(b.execution.executionId),
    );
    kernel.closed.mockImplementation(async (identity) => {
      if (identity.executionId !== order[8]!.execution.executionId) {
        throw new Error("Unavailable");
      }
      return true;
    });
    const first = await ninth.sweep();
    expect(first.inspected).toBe(8);
    expect(first.nextExecutionId).toBeDefined();
    const next = await ninth.sweep(first.nextExecutionId);
    expect(next.inspected).toBe(2);
    expect(next.nextExecutionId).toBeUndefined();
    expect(
      getSupervisedCommandResources(order[8]!.execution.executionId, ninth.options)?.state,
    ).toBe("closed");
    expect(
      getSupervisedCommandResources(planned.execution.executionId, planned.options)?.state,
    ).toBe("planned");
    kernel.closed.mockClear().mockResolvedValue(true);
    const target = order[0]!;
    await target.sweep(undefined, target.flowId);
    expect(kernel.closed).toHaveBeenCalledTimes(1);
    expect(kernel.closed).toHaveBeenCalledWith(target.identity);
  });
});

describe("prebinding command recovery evidence", () => {
  function unbound() {
    const f = fixture(undefined, "work", false);
    bindSupervisedOperationProcess(
      f.execution,
      requireNodeWorkerProcessIdentity(process.pid),
      1005,
      f.options,
    );
    return f;
  }

  it.each(["dead", "reused"] as const)(
    "recovers a never-started %s owner after reopen and fences late transport",
    async (state) => {
      const f = unbound();
      const before = getSupervisedOperationExecution(f.execution.executionId, f.options);
      kernel.process.mockReturnValue(state);
      closeOpenClawStateDatabaseForTest();
      await f.sweep();
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
        "closed",
      );
      expect(() => startSupervisedCommandTransport(f.execution, 2001, f.options)).toThrow(
        /gate unavailable/,
      );
      expect(getSupervisedOperationExecution(f.execution.executionId, f.options)).toEqual(before);
      expect(kernel.absent).not.toHaveBeenCalled();
      expect(kernel.terminate).not.toHaveBeenCalled();
    },
  );

  it.each(["live", "unknown"] as const)(
    "retains an expired %s owner instead of trusting scope absence",
    async (state) => {
      const f = unbound();
      vi.setSystemTime(122_000);
      kernel.process.mockReturnValue(state);
      await f.sweep();
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
        "planned",
      );
      expect(kernel.absent).not.toHaveBeenCalled();
      expect(kernel.terminate).not.toHaveBeenCalled();
    },
  );

  it("retains a dead owner's started transport even if its unit is absent now", async () => {
    const f = unbound();
    startSupervisedCommandTransport(f.execution, 1006, f.options);
    kernel.process.mockReturnValue("dead");
    await f.sweep();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("sealed");
    expect(kernel.absent).not.toHaveBeenCalled();
    expect(() => bindSupervisedCommandResources(f.execution, f.identity, 2001, f.options)).toThrow(
      /consumed/,
    );
    reconcileSupervisedOperationCapacity(2002, f.options);
    expect(
      readSupervisedWorkflow(
        (db) =>
          executeSqliteQuerySync(
            db,
            getNodeSqliteKysely<DB>(db)
              .selectFrom("task_flow_operation_launches")
              .select("state")
              .where("execution_id", "=", f.execution.executionId),
          ).rows[0]?.state,
        f.options,
      ),
    ).toBe("spawned");
  });

  it.each(["not_started", "started", "extinct"] as const)(
    "recovers %s after a same-host reboot, including a coincidentally live runner PID",
    async (transport) => {
      const f = unbound();
      if (transport !== "not_started") {
        startSupervisedCommandTransport(f.execution, 1006, f.options);
      }
      if (transport === "extinct") {
        recordSupervisedCommandTransportExtinct(f.execution, 1007, f.options);
      }
      kernel.host.mockReturnValue({
        hostId: "b".repeat(64),
        bootId: "8c4348aa-332c-4469-a724-9f5bb12e843e",
      });
      closeOpenClawStateDatabaseForTest();
      await f.sweep();
      reconcileSupervisedOperationCapacity(2003, f.options);
      expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
        "closed",
      );
      expect(
        readSupervisedWorkflow(
          (db) =>
            executeSqliteQuerySync(
              db,
              getNodeSqliteKysely<DB>(db)
                .selectFrom("task_flow_operation_launches")
                .select("state")
                .where("execution_id", "=", f.execution.executionId),
            ).rows[0]?.state,
          f.options,
        ),
      ).toBe("gone");
      expect(kernel.absent).not.toHaveBeenCalled();
      expect(kernel.terminate).not.toHaveBeenCalled();
    },
  );

  it("does not retire a copied-host or legacy unknown plan", async () => {
    const f = unbound();
    kernel.host.mockReturnValue({
      hostId: "c".repeat(64),
      bootId: "8c4348aa-332c-4469-a724-9f5bb12e843e",
    });
    kernel.process.mockReturnValue("dead");
    await f.sweep();
    expect(f.onError).toHaveBeenCalledOnce();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
      "planned",
    );
    writeSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("task_flow_command_resources")
            .set({ identity_json: null })
            .where("execution_id", "=", f.execution.executionId),
        ),
      f.options,
    );
    await f.sweep();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe(
      "planned",
    );
    expect(kernel.absent).not.toHaveBeenCalled();
  });

  it("does not close after cleanup authority is lost while awaiting absence", async () => {
    const f = unbound();
    startSupervisedCommandTransport(f.execution, 1006, f.options);
    recordSupervisedCommandTransportExtinct(f.execution, 1007, f.options);
    let current = true;
    kernel.absent.mockImplementation(async () => {
      current = false;
      return true;
    });
    await reconcileSupervisedCommandResources({
      options: f.options,
      ownerId: "supervisor",
      onError: f.onError,
      assertCleanupCurrent: () => {
        if (!current) {
          throw new Error("Cleanup stopped");
        }
      },
    });
    expect(f.onError).toHaveBeenCalledOnce();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("sealed");
    expect(kernel.terminate).not.toHaveBeenCalled();
  });

  it("retries sealed absence observation using persisted transport extinction", async () => {
    const f = unbound();
    startSupervisedCommandTransport(f.execution, 1006, f.options);
    recordSupervisedCommandTransportExtinct(f.execution, 1007, f.options);
    kernel.absent.mockRejectedValueOnce(new Error("manager unavailable"));
    await f.sweep();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("sealed");
    closeOpenClawStateDatabaseForTest();
    await f.sweep();
    expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("closed");
    expect(kernel.terminate).not.toHaveBeenCalled();
  });
});

it("retires a never-started plan after its exact planning process is dead", async () => {
  const f = fixture(undefined, "prebinding-owner-exit", false);
  kernel.process.mockReturnValue("dead");
  await f.sweep();
  expect(getSupervisedCommandResources(f.execution.executionId, f.options)?.state).toBe("closed");
  expect(kernel.terminate).not.toHaveBeenCalled();
  expect(getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome).toBeNull();
});
