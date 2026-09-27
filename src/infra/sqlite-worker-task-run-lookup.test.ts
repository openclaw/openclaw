import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { findTaskViewByRunIdAsync } from "../tasks/runtime-internal.js";
import { createAcpTaskBackingDetail } from "../tasks/task-backing-records.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import { upsertTaskWithDeliveryStateToSqlite } from "../tasks/task-registry.store.sqlite.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { requireNodeSqlite } from "./node-sqlite.js";

let state: OpenClawTestState;
const ownerKey = "agent:main:lookup";
const runId = "reused-run";

function task(taskId: string, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId,
    runtime: "acp",
    requesterSessionKey: ownerKey,
    ownerKey,
    scopeKind: "session",
    childSessionKey: "agent:main:acp:child",
    parentFlowId: "canonical-flow",
    runId,
    task: "Synthetic generation lookup",
    status: "running",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: 100,
    ...overrides,
  };
}

beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-run-lookup-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

function seed(records: TaskRecord[]) {
  for (const flowId of ["canonical-flow", "managed-flow"]) {
    upsertTaskFlowRegistryRecordToSqlite({
      flowId,
      syncMode: flowId === "canonical-flow" ? "task_mirrored" : "managed",
      controllerId: "tests/lookup",
      ownerKey,
      revision: 0,
      status: "running",
      notifyPolicy: "silent",
      goal: "Synthetic generation",
      createdAt: 100,
      updatedAt: 100,
    });
  }
  for (const record of records) {
    upsertTaskWithDeliveryStateToSqlite({ task: record });
  }
}

describe("registered task run lookup", () => {
  it.each(["point", "padded point", "resolve"] as const)(
    "selects the current ACP generation through the %s command without returning private detail",
    async (lookup) => {
      seed([
        task("legacy"),
        task("old", { detail: createAcpTaskBackingDetail("old", 1) }),
        task("current", {
          createdAt: 200,
          detail: { ...createAcpTaskBackingDetail("current", 2), private: "must not escape" },
        }),
      ]);
      await closeOpenClawStateDatabaseAsync();
      const result =
        lookup !== "resolve"
          ? await findTaskViewByRunIdAsync(
              lookup === "padded point" ? ` ${runId} ` : runId,
              () => {},
            )
          : await runOpenClawStateWorkerOperation(
              captureOpenClawStateWorkerContext(),
              async (scope) => {
                const resolved = await scope.execute({
                  type: "tasks.resolve",
                  input: { ownerKey, token: runId },
                });
                return resolved.byRun;
              },
              { existingOnly: true },
            );
      expect(result?.taskId).toBe("current");
      expect(result).not.toHaveProperty("detail");
      expect(result).not.toHaveProperty("executionOwner");
    },
  );

  it("keeps the async task-ID tie order after filtering current mirrors", async () => {
    seed([
      task("z-canonical", { detail: createAcpTaskBackingDetail("current", 2) }),
      task("a-mirror", {
        parentFlowId: "managed-flow",
        detail: createAcpTaskBackingDetail("current", 2),
      }),
    ]);
    await closeOpenClawStateDatabaseAsync();
    expect((await findTaskViewByRunIdAsync(runId, () => {}))?.taskId).toBe("a-mirror");
  });

  it("does not create missing state for a point lookup", async () => {
    const pathname = resolveOpenClawStateSqlitePath();
    expect(existsSync(pathname)).toBe(false);
    expect(await findTaskViewByRunIdAsync(runId, () => {})).toBeUndefined();
    await closeOpenClawStateDatabaseAsync();
    expect(existsSync(pathname)).toBe(false);
  });

  it("reads a persisted point without main-thread SQLite execution", async () => {
    seed([task("persisted", { runtime: "subagent" })]);
    await closeOpenClawStateDatabaseAsync();
    requireNodeSqlite();
    const counters = observeMainThreadSql();
    expect((await findTaskViewByRunIdAsync(runId, () => {}))?.taskId).toBe("persisted");
    counters.expectIdle();
  });
});
