import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { requireNodeWorkerProcessIdentity } from "../node-host/node-worker-process-identity.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  bindSupervisedCommandResources,
  getSupervisedCommandResources,
  planSupervisedCommandResources,
  planSupervisedReviewResources,
  recordSupervisedCommandResourcesClosed,
} from "./supervised-command-custody.js";
import {
  supervisedCommandScopeName,
  type SupervisedCommandScopeIdentity,
} from "./supervised-command-resources.js";
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
  recordSupervisedOperationOutcome,
  markSupervisedOperationReconciling,
  resolveSupervisedOperationReconciliation,
  reserveSupervisedOperationDispatch,
} from "./supervised-operation.store.js";
import {
  claimSupervisedTask,
  createSupervisedTask,
  heartbeatTaskSupervisor,
  reserveSupervisedDispatch,
} from "./supervised-task.store.js";
import {
  readSupervisedWorkflow,
  writeSupervisedWorkflow,
} from "./supervised-workflow.persistence.js";
import { encodeSupervisedWorkflowContract } from "./supervised-workflow.types.js";
import { supervisedWorkspaceVersionPath } from "./supervised-workspace-path.js";
import {
  reserveSupervisedWorkspace,
  retireSupervisedWorkspaces,
} from "./supervised-workspace-retention.js";

const dirs = createTempDirTracker();

function admitted(
  kind: "command" | "review" = "review",
  root = dirs.make("openclaw-review-custody-"),
  flowId = "work",
) {
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
        kind === "command"
          ? {
              kind,
              id: "check",
              executable: process.execPath,
              executableSha256: "0".repeat(64),
              argv: ["--version"],
              timeoutMs: 1000,
            }
          : {
              kind,
              id: "check",
              runtime: "claude-cli",
              agentId: "reviewer",
              model: "anthropic/test",
              instructions: "Check correctness",
              paths: ["program.ts"],
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
    { key: "check-1", kind, profile: "check", input: {} },
    1001,
    options,
  );
  return { root, options, task, operation };
}

function claimed(kind: "command" | "review" = "review") {
  const f = admitted(kind);
  const execution = claimSupervisedOperation(
    f.operation.operationId,
    "runner",
    1002,
    f.options,
    requireNodeWorkerProcessIdentity(process.pid),
  );
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
  closeOpenClawStateDatabaseForTest();
  dirs.cleanup();
});

describe("review receipt requires physical runtime closure", () => {
  it("does not dispatch a review without bound custody", () => {
    const f = claimed();
    expect(() => reserveSupervisedOperationDispatch(f.execution, 1003, f.options)).toThrow(
      /bound runtime custody/,
    );
    expect(
      getSupervisedOperationExecution(f.execution.executionId, f.options)?.dispatchedAt,
    ).toBeNull();
  });
  it.each(["succeeded", "failed", "input_required"] as const)(
    "withholds %s receipt until exact bound scope closes",
    (status) => {
      const f = claimed();
      planSupervisedReviewResources(f.execution, 1003, f.options);
      const resource = identity(f.execution.executionId);
      bindSupervisedCommandResources(f.execution, resource, 1004, f.options);
      reserveSupervisedOperationDispatch(f.execution, 1005, f.options);
      const before = getSupervisedOperation(f.operation.operationId, f.options);
      const outcome = { status, summary: "Review observed", facts: {}, artifacts: [] };
      expect(() => recordSupervisedOperationOutcome(f.execution, outcome, 1006, f.options)).toThrow(
        /closure remains unresolved/,
      );
      expect(getSupervisedOperation(f.operation.operationId, f.options)).toEqual(before);
      expect(
        getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome,
      ).toBeNull();
      // Synthetic closure observation tests SQL enforcement, not kernel extinction.
      recordSupervisedCommandResourcesClosed(resource, 1007, f.options);
      recordSupervisedOperationOutcome(f.execution, outcome, 1008, f.options);
      expect(
        getSupervisedOperationExecution(f.execution.executionId, f.options)?.outcome?.status,
      ).toBe(status);
    },
  );
  it("keeps operation kind validation at both planners", () => {
    const review = claimed();
    expect(() => planSupervisedCommandResources(review.execution, 1003, review.options)).toThrow(
      /before payload dispatch/,
    );
    expect(
      getSupervisedCommandResources(review.execution.executionId, review.options),
    ).toBeUndefined();
    const command = claimed("command");
    expect(() => planSupervisedReviewResources(command.execution, 1003, command.options)).toThrow(
      /before payload dispatch/,
    );
    expect(
      getSupervisedCommandResources(command.execution.executionId, command.options),
    ).toBeUndefined();
  });
});

describe("review recovery cannot invent process closure", () => {
  function bound() {
    const f = claimed();
    planSupervisedReviewResources(f.execution, 1003, f.options);
    const resource = identity(f.execution.executionId);
    bindSupervisedCommandResources(f.execution, resource, 1004, f.options);
    reserveSupervisedOperationDispatch(f.execution, 1005, f.options);
    return { ...f, resource };
  }
  it("retains physical capacity even when the independent runner is gone", () => {
    const f = bound();
    observeSupervisedOperationProcess(
      f.execution.executionId,
      { pid: 2147483647, startTime: 1 },
      1006,
      f.options,
    );
    const state = () =>
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
    reconcileSupervisedOperationCapacity(1007, f.options);
    expect(state()).toBe("spawned");
    recordSupervisedCommandResourcesClosed(f.resource, 1008, f.options);
    reconcileSupervisedOperationCapacity(1009, f.options);
    expect(state()).toBe("gone");
  });
  it("does not finalize or retry a dispatched legacy review with missing physical custody", () => {
    const f = bound();
    // Represents pre-containment persisted history. Removing this synthetic SQL
    // observation is not a claim that a real process was closed.
    writeSupervisedWorkflow(
      (db) =>
        executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<DB>(db)
            .deleteFrom("task_flow_command_resources")
            .where("execution_id", "=", f.execution.executionId),
        ),
      f.options,
    );
    expect(() =>
      recordSupervisedOperationOutcome(
        f.execution,
        { status: "failed", summary: "deadline", facts: {}, artifacts: [] },
        1006,
        f.options,
      ),
    ).toThrow(/closure remains unresolved/);
    const operation = markSupervisedOperationReconciling(
      f.execution,
      f.execution.leaseExpiresAt + 1,
      f.options,
    );
    const before = getSupervisedOperation(operation.operationId, f.options);
    expect(() =>
      resolveSupervisedOperationReconciliation(
        operation,
        { retryAt: f.execution.leaseExpiresAt + 2, evidence: "Runner is gone, closure unknown" },
        f.execution.leaseExpiresAt + 2,
        f.options,
      ),
    ).toThrow(/closure remains unresolved/);
    expect(getSupervisedOperation(operation.operationId, f.options)).toEqual(before);
  });
});

// Receipt and scratch retirement are atomic, so a dying outer runner cannot
// accumulate one 64-MiB reservation for each completed read-only review.
it.each(["succeeded", "failed", "input_required"] as const)(
  "retires only closure-proven %s review scratch",
  async (status) => {
    const f = claimed();
    bindSupervisedOperationProcess(
      f.execution,
      requireNodeWorkerProcessIdentity(process.pid),
      1003,
      f.options,
    );
    const execution = getSupervisedOperationExecution(f.execution.executionId, f.options)!;
    const allocation = reserveSupervisedWorkspace(
      { kind: "operation", execution },
      "draft",
      1004,
      f.options,
    );
    const root = supervisedWorkspaceVersionPath(allocation, f.options);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(`${root}/evidence`, "preserve unknown outcomes");
    planSupervisedReviewResources(execution, 1004, f.options);
    const resource = identity(execution.executionId);
    bindSupervisedCommandResources(execution, resource, 1005, f.options);
    reserveSupervisedOperationDispatch(execution, 1006, f.options);
    recordSupervisedCommandResourcesClosed(resource, 1007, f.options);
    recordSupervisedOperationOutcome(
      execution,
      { status, summary: "Read-only review complete", facts: {}, artifacts: [] },
      1008,
      f.options,
    );
    closeOpenClawStateDatabaseForTest();
    expect(await retireSupervisedWorkspaces(1009, f.options)).toBe(
      status === "input_required" ? 0 : 1,
    );
    expect(existsSync(`${root}/evidence`)).toBe(status === "input_required");
  },
);
