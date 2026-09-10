import { mkdirSync } from "node:fs";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { startSupervisedOperationDispatcher } from "./supervised-operation.dispatcher.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
} from "./supervised-workflow.persistence.js";
const launch = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("./supervised-operation.launch.js", () => ({ launchSupervisedOperationProcess: launch }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  observeSupervisedOperationProcess,
  recordSupervisedOperationBootstrapExited,
  recordSupervisedOperationNotSpawned,
  reconcileSupervisedOperationCapacity,
} from "./supervised-operation.capacity.js";
import {
  assertSupervisedOperationCurrent,
  claimSupervisedOperation,
  enqueueSupervisedOperation,
  getSupervisedOperation,
  getSupervisedOperationExecution,
  heartbeatSupervisedOperation,
  listSupervisedOperations,
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
  stopTaskSupervisor,
  reconcileSupervisedTasks,
} from "./supervised-task.store.js";
import {
  authorizeSupervisedWorkflowRequest,
  encodeSupervisedWorkflowContract,
} from "./supervised-workflow.types.js";

const dirs = createTempDirTracker();
const request = { key: "check-1", kind: "command", profile: "check", input: {} } as const;
const ok = {
  status: "succeeded",
  summary: "Host check exited zero",
  facts: { exitCode: "0" },
  artifacts: [],
} as const;
function fixture(sharedRoot?: string, flowId = "work") {
  const root = sharedRoot ?? dirs.make("openclaw-operation-");
  mkdirSync(`${root}/workspace-${flowId}`, { recursive: true });
  const options = { env: { OPENCLAW_STATE_DIR: `${root}/state` } };
  const goal = {
    objective: "Repair a program",
    success: [{ id: "correct", description: "Accepted behavioral checks pass" }],
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
  const input = {
    flowId,
    agentId: "poc",
    runtime: "codex" as const,
    model: "openai/test",
    prompt: "Repair it",
    goal,
    policy: { deadlineAt: 100_000, maxAttempts: 10, attemptTimeoutMs: 10_000 },
    workflow,
  };
  const task = createSupervisedTask(input, "coordinator", 1000, options);
  const claimed = claimSupervisedTask(task.flowId, "coordinator", 1000, options)!;
  const expected = reserveSupervisedDispatch(claimed, 1000, options);
  return { root, options, task, expected, input, workflow };
}
function admitted() {
  const f = fixture();
  const operation = enqueueSupervisedOperation(f.expected, request, 1001, f.options);
  return { ...f, operation };
}
function dispatched() {
  const f = admitted();
  const execution = claimSupervisedOperation(f.operation.operationId, "runner", 1002, f.options)!;
  reserveSupervisedOperationDispatch(execution, 1003, f.options);
  return { ...f, execution };
}
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe("durable operation custody", () => {
  it("commits reservation and waiting together without another model claim", () => {
    const f = admitted();
    expect(getSupervisedTask("work", f.options)).toMatchObject({ phase: "waiting", attempt: null });
    expect(listSupervisedOperations(f.options, "work", 1)).toHaveLength(1);
    expect(claimSupervisedTask("work", "coordinator", 3000, f.options)).toBeUndefined();
  });
  it("rejects a widened operation without changing task or inserting a row", () => {
    const f = fixture();
    const before = getSupervisedTask("work", f.options);
    expect(() =>
      enqueueSupervisedOperation(
        f.expected,
        { ...request, input: { command: "anything" } },
        1001,
        f.options,
      ),
    ).toThrow(/accepted immutable/);
    expect(getSupervisedTask("work", f.options)).toEqual(before);
    expect(listSupervisedOperations(f.options, "work", 1)).toEqual([]);
  });
  it("has one winner when independent runners race", () => {
    const f = admitted();
    const first = claimSupervisedOperation(f.operation.operationId, "one", 1002, f.options);
    expect(first?.generation).toBe(1);
    expect(
      claimSupervisedOperation(f.operation.operationId, "two", 1002, f.options),
    ).toBeUndefined();
  });
  it("retains delegated custody when only the coordinator disappears", () => {
    const f = dispatched();
    stopTaskSupervisor("coordinator", 1004, f.options);
    expect(() => assertSupervisedOperationCurrent(f.execution, 1005, f.options)).not.toThrow();
    heartbeatSupervisedOperation(f.execution, 1005, f.options);
    expect(recordSupervisedOperationOutcome(f.execution, ok, 1006, f.options).state).toBe(
      "succeeded",
    );
    expect(getSupervisedTask("work", f.options)?.endpoint).toBeNull();
  });
  it("revokes new effects on cancellation but retains the exact late observation", () => {
    const f = dispatched();
    const endpoint = cancelSupervisedTask("work", 1004, f.options);
    expect(() => assertSupervisedOperationCurrent(f.execution, 1005, f.options)).toThrow(
      /no longer/,
    );
    const result = recordSupervisedOperationOutcome(f.execution, ok, 1006, f.options);
    expect(result.state).toBe("cancelled");
    expect(
      getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome?.status,
    ).toBe("succeeded");
    expect(getSupervisedTask("work", f.options)).toEqual(endpoint);
  });
  it("does not infer replay permission from expired dispatch leases", () => {
    const f = dispatched();
    expect(() => heartbeatSupervisedOperation(f.execution, 12_000, f.options)).toThrow(/no longer/);
    const reconciling = markSupervisedOperationReconciling(f.execution, 12_000, f.options);
    expect(reconciling.state).toBe("reconciling");
    expect(
      claimSupervisedOperation(f.operation.operationId, "replacement", 12_001, f.options),
    ).toBeUndefined();
    expect(() => reserveSupervisedOperationDispatch(f.execution, 12_001, f.options)).toThrow(
      /no longer/,
    );
  });
  it("replays an identical receipt without rerunning the external operation", () => {
    const f = dispatched();
    recordSupervisedOperationOutcome(f.execution, ok, 1004, f.options);
    const next = claimSupervisedTask("work", "coordinator", 1005, f.options)!;
    const replay = enqueueSupervisedOperation(next, request, 1006, f.options);
    expect(replay.operationId).toBe(f.operation.operationId);
    expect(replay.outcome?.status).toBe("succeeded");
    expect(
      claimSupervisedOperation(replay.operationId, "extra-runner", 1007, f.options),
    ).toBeUndefined();
    expect(listSupervisedOperations(f.options, "work", 1)).toHaveLength(1);
  });
  it("rejects a reused key with a different frozen request", () => {
    const f = dispatched();
    recordSupervisedOperationOutcome(f.execution, ok, 1004, f.options);
    const next = claimSupervisedTask("work", "coordinator", 1005, f.options)!;
    expect(() =>
      enqueueSupervisedOperation(next, { ...request, kind: "review" }, 1006, f.options),
    ).toThrow(/accepted immutable/);
    expect(getSupervisedTask("work", f.options)?.attempt?.id).toBe(next.attempt?.id);
  });
  it("retains immutable original observations without overwriting a replacement", () => {
    const f = dispatched();
    const reconciling = markSupervisedOperationReconciling(f.execution, 12_000, f.options);
    resolveSupervisedOperationReconciliation(
      reconciling,
      {
        retryAt: 12_001,
        evidence: "Host proved repeatable isolated check and original process extinction",
      },
      12_000,
      f.options,
    );
    const replacement = claimSupervisedOperation(
      f.operation.operationId,
      "replacement",
      12_001,
      f.options,
    )!;
    const before = getSupervisedOperation(f.operation.operationId, f.options);
    recordSupervisedOperationOutcome(f.execution, ok, 12_002, f.options);
    expect(getSupervisedOperation(f.operation.operationId, f.options)).toEqual(before);
    expect(() => assertSupervisedOperationCurrent(replacement, 12_003, f.options)).not.toThrow();
    expect(
      getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome?.status,
    ).toBe("succeeded");
  });
  it("rejects successful receipts before dispatch and conflicting second answers", () => {
    const f = admitted();
    const execution = claimSupervisedOperation(f.operation.operationId, "runner", 1002, f.options)!;
    expect(() => recordSupervisedOperationOutcome(execution, ok, 1003, f.options)).toThrow(
      /Undispatched/,
    );
    reserveSupervisedOperationDispatch(execution, 1003, f.options);
    const first = recordSupervisedOperationOutcome(execution, ok, 1004, f.options);
    expect(recordSupervisedOperationOutcome(execution, ok, 1005, f.options)).toEqual(first);
    expect(() =>
      recordSupervisedOperationOutcome(execution, { ...ok, summary: "changed" }, 1006, f.options),
    ).toThrow(/immutable/);
  });
  it("keeps oversized result rejection atomic and permits an explicit bounded failure", () => {
    const f = dispatched();
    expect(() =>
      recordSupervisedOperationOutcome(
        f.execution,
        {
          ...ok,
          facts: Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [String(i), "x".repeat(8000)]),
          ),
        },
        1004,
        f.options,
      ),
    ).toThrow(/budget/);
    expect(getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome).toBeNull();
    expect(
      recordSupervisedOperationOutcome(
        f.execution,
        { status: "failed", summary: "Output exceeded the accepted receipt budget" },
        1005,
        f.options,
      ).state,
    ).toBe("failed");
  });
  it("atomically rejects another writer admitted for the same workspace", () => {
    const f = fixture();
    expect(() =>
      createSupervisedTask({ ...f.input, flowId: "other" }, "coordinator", 1001, f.options),
    ).toThrow(/active supervised writer/);
    expect(getSupervisedTask("other", f.options)).toBeUndefined();
  });
});

describe("accepted workflow profiles", () => {
  it("rejects traversal, unknown criteria and credential fields", () => {
    const f = fixture();
    const command = f.workflow.profiles[0]!;
    expect(() =>
      encodeSupervisedWorkflowContract({
        ...f.workflow,
        profiles: [{ ...command, cwd: "../state" }],
      }),
    ).toThrow();
    expect(() =>
      encodeSupervisedWorkflowContract({
        ...f.workflow,
        profiles: [{ ...command, env: { TOKEN: "not permitted" } }],
      }),
    ).toThrow();
    expect(() =>
      encodeSupervisedWorkflowContract({
        ...f.workflow,
        acceptance: [{ kind: "receipts", criterionId: "correct", profiles: ["unknown"] }],
      }),
    ).toThrow();
    expect(() =>
      authorizeSupervisedWorkflowRequest(f.workflow, { ...request, profile: "unknown" }),
    ).toThrow();
  });
});

it.each(["cancel", "deadline"] as const)(
  "%s of a waiting episode preserves independent dispatched-effect uncertainty",
  (kind) => {
    const f = fixture();
    const operation = enqueueSupervisedOperation(f.expected, request, 1000, f.options);
    const execution = claimSupervisedOperation(operation.operationId, "runner", 1000, f.options)!;
    reserveSupervisedOperationDispatch(execution, 1000, f.options);
    expect(getSupervisedTask(f.task.flowId, f.options)?.phase).toBe("waiting");
    if (kind === "cancel") {
      cancelSupervisedTask(f.task.flowId, 1001, f.options);
    } else {
      reconcileSupervisedTasks(100_001, f.options);
    }
    expect(getSupervisedTask(f.task.flowId, f.options)?.endpoint?.effects).toBe("unknown");
    const endpoint = getSupervisedTask(f.task.flowId, f.options);
    recordSupervisedOperationOutcome(execution, ok, 100_002, f.options);
    expect(getSupervisedTask(f.task.flowId, f.options)).toEqual(endpoint);
  },
);

describe("physical operation capacity", () => {
  function full() {
    const root = dirs.make("openclaw-operation-capacity-");
    const launcher = requireNodeWorkerProcessIdentity(process.pid);
    const items = Array.from({ length: 9 }, (_, i) => {
      const f = fixture(root, `task-${i}`);
      const operation = enqueueSupervisedOperation(f.expected, request, 1001, f.options);
      return { ...f, operation };
    });
    const executions = items
      .slice(0, 8)
      .map((f) =>
        claimSupervisedOperation(f.operation.operationId, "runner", 1002, f.options, launcher)!,
      );
    return { items, executions, launcher, ninth: items[8]! };
  }
  it
    .skipIf(process.platform !== "linux")
    .each(["changed boot", "different host", "legacy unknown"] as const)(
    "retains truthful reservation custody for %s evidence after reopen",
    (evidence) => {
      const f = full();
      const executionId = f.executions[0]!.executionId;
      // Real reservation producer captured launchHost. Change only that durable
      // evidence to model a previous boot / foreign database / legacy version.
      writeSupervisedWorkflow((db) => {
        const row = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_operation_executions")
            .select("record_json")
            .where("execution_id", "=", executionId),
        ).rows[0]!;
        const record = JSON.parse(row.record_json);
        expect(record.launchHost).toEqual({
          hostId: expect.stringMatching(/^[a-f0-9]{64}$/),
          bootId: expect.any(String),
        });
        if (evidence === "changed boot") {
          record.launchHost.bootId = "8c4348aa-332c-4469-a724-9f5bb12e843e";
        }
        if (evidence === "different host") {
          record.launchHost.hostId = "0".repeat(64);
        }
        if (evidence === "legacy unknown") {
          delete record.launchHost;
        }
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .updateTable("task_flow_operation_executions")
            .set({ record_json: JSON.stringify(record) })
            .where("execution_id", "=", executionId),
        );
      }, f.ninth.options);
      closeOpenClawStateDatabaseForTest();
      reconcileSupervisedOperationCapacity(1003, f.ninth.options);
      const claim = () =>
        claimSupervisedOperation(
          f.ninth.operation.operationId,
          "ninth",
          1004,
          f.ninth.options,
          f.launcher,
        );
      if (evidence === "changed boot") {
        expect(claim()).toBeDefined();
      } else {
        expect(claim).toThrow(/capacity/);
      }
      expect(getSupervisedOperationExecution(executionId, f.ninth.options)?.outcome).toBeNull();
    },
  );
  it("releases a definite pre-observation bootstrap exit without inventing not-spawned or a receipt", () => {
    const f = full();
    const execution = f.executions[0]!;
    const before = getSupervisedOperationExecution(execution.executionId, f.ninth.options);
    recordSupervisedOperationBootstrapExited(
      execution.executionId,
      f.launcher,
      1003,
      f.ninth.options,
    );
    closeOpenClawStateDatabaseForTest();
    expect(
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        1004,
        f.ninth.options,
        f.launcher,
      ),
    ).toBeDefined();
    expect(getSupervisedOperationExecution(execution.executionId, f.ninth.options)).toEqual(before);
    expect(() =>
      observeSupervisedOperationProcess(execution.executionId, f.launcher, 1005, f.ninth.options),
    ).toThrow(/resolved/);
  });
  it("rejects wrong-owner bootstrap exit evidence and cannot retire an observed runner", () => {
    const f = full();
    const execution = f.executions[0]!;
    recordSupervisedOperationBootstrapExited(
      execution.executionId,
      { ...f.launcher, startTime: f.launcher.startTime + 1 },
      1003,
      f.ninth.options,
    );
    expect(() =>
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        1004,
        f.ninth.options,
        f.launcher,
      ),
    ).toThrow(/capacity/);
    observeSupervisedOperationProcess(execution.executionId, f.launcher, 1005, f.ninth.options);
    recordSupervisedOperationBootstrapExited(
      execution.executionId,
      f.launcher,
      1006,
      f.ninth.options,
    );
    expect(() =>
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        1007,
        f.ninth.options,
        f.launcher,
      ),
    ).toThrow(/capacity/);
  });
  it("reserves capacity before spawn and retains unknown processes across lease expiry and reopen", () => {
    const f = full();
    expect(() =>
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        1003,
        f.ninth.options,
        f.launcher,
      ),
    ).toThrow(/capacity/);
    expect(getSupervisedOperation(f.ninth.operation.operationId, f.ninth.options)).toMatchObject({
      generation: 0,
      state: "queued",
    });
    closeOpenClawStateDatabaseForTest();
    reconcileSupervisedOperationCapacity(50_000, f.ninth.options);
    expect(() =>
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        50_000,
        f.ninth.options,
        f.launcher,
      ),
    ).toThrow(/capacity/);
    recordSupervisedOperationNotSpawned(
      f.executions[0]!.executionId,
      f.launcher,
      50_001,
      f.ninth.options,
    );
    expect(
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        50_002,
        f.ninth.options,
        f.launcher,
      )?.generation,
    ).toBe(1);
  });
  it("does not free a live process on a completion receipt, but frees a proven exited identity", () => {
    const f = full();
    const execution = f.executions[0]!;
    observeSupervisedOperationProcess(execution.executionId, f.launcher, 1003, f.ninth.options);
    reserveSupervisedOperationDispatch(execution, 1004, f.ninth.options);
    recordSupervisedOperationOutcome(execution, ok, 1005, f.ninth.options);
    reconcileSupervisedOperationCapacity(1006, f.ninth.options);
    expect(() =>
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        1007,
        f.ninth.options,
        f.launcher,
      ),
    ).toThrow(/capacity/);
    // A mismatched process start time is PID reuse, not the old physical runner.
    observeSupervisedOperationProcess(
      f.executions[1]!.executionId,
      { ...f.launcher, startTime: f.launcher.startTime + 1 },
      1008,
      f.ninth.options,
    );
    reconcileSupervisedOperationCapacity(1009, f.ninth.options);
    expect(
      claimSupervisedOperation(
        f.ninth.operation.operationId,
        "ninth",
        1010,
        f.ninth.options,
        f.launcher,
      ),
    ).toBeDefined();
  });
  it("accepts an exact late observation without reopening execution authority", () => {
    const f = admitted();
    const launcher = requireNodeWorkerProcessIdentity(process.pid);
    const execution = claimSupervisedOperation(
      f.operation.operationId,
      "runner",
      1002,
      f.options,
      launcher,
    )!;
    cancelSupervisedTask(f.task.flowId, 1003, f.options);
    observeSupervisedOperationProcess(execution.executionId, launcher, 1004, f.options);
    observeSupervisedOperationProcess(execution.executionId, launcher, 1005, f.options);
    expect(() => reserveSupervisedOperationDispatch(execution, 1006, f.options)).toThrow();
    expect(() =>
      observeSupervisedOperationProcess(
        execution.executionId,
        { ...launcher, startTime: launcher.startTime + 1 },
        1007,
        f.options,
      ),
    ).toThrow(/immutable/);
    expect(() =>
      recordSupervisedOperationNotSpawned(execution.executionId, launcher, 1008, f.options),
    ).toThrow(/definite spawn failure/);
  });
});

it("isolates a corrupt operation without hiding its bytes or starving an unrelated queued task", async () => {
  const broken = admitted();
  const healthy = fixture(broken.root, "healthy");
  const operation = enqueueSupervisedOperation(healthy.expected, request, 1002, healthy.options);
  writeSupervisedWorkflow(
    (db) =>
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DB>(db)
          .updateTable("task_flow_operations")
          .set({ record_json: "{}" })
          .where("operation_id", "=", broken.operation.operationId),
      ),
    broken.options,
  );
  const before = getSupervisedTask("work", broken.options);
  launch.mockClear();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(20_000);
  const dispatcher = startSupervisedOperationDispatcher({
    options: broken.options,
    onError: () => {},
  });
  try {
    await vi.waitFor(() =>
      expect(launch).toHaveBeenCalledWith(operation.operationId, healthy.options),
    );
    expect(getSupervisedTask("work", broken.options)).toEqual(before);
    const rows = readSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_operations")
            .select("record_json")
            .where("operation_id", "=", broken.operation.operationId),
        ).rows,
      broken.options,
    );
    expect(rows).toEqual([{ record_json: "{}" }]);
    const fault = readSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .selectFrom("task_flow_recovery")
            .select("fault_json")
            .where("flow_id", "=", "work"),
        ).rows[0],
      broken.options,
    );
    expect(JSON.parse(fault!.fault_json!)).toMatchObject({
      kind: "input_required",
      operationId: broken.operation.operationId,
    });
    expect(listSupervisedOperations(broken.options).map((item) => item.operationId)).toEqual([
      operation.operationId,
    ]);
  } finally {
    dispatcher.stop();
    vi.useRealTimers();
  }
});
