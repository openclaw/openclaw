import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import * as coordinator from "../infra/state-database-coordinator.js";
import { buildFlowRecord } from "../tasks/task-flow-registry.records.js";
import { readTaskFlowRecord } from "../tasks/task-flow-registry.store.kernel.js";
import { upsertTaskFlowRegistryRecordToSqlite } from "../tasks/task-flow-registry.store.sqlite.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { closeOpenClawStateDatabaseAsync } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import { createSqliteWorkerBackend } from "./openclaw-state.worker.js";

let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ prefix: "openclaw-managed-outcome-", applyEnv: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
  await state.cleanup();
});

it.each(["create", "update"] as const)(
  "preserves the committed managed %s result when coordinator cleanup fails",
  async (operation) => {
    const flow = buildFlowRecord({
      controllerId: "tests/committed-result",
      ownerKey: "agent:main:main",
      goal: "Synthetic committed flow",
      createdAt: 100,
    });
    if (operation === "update") {
      upsertTaskFlowRegistryRecordToSqlite(flow);
    }
    const context = captureOpenClawStateWorkerContext();
    const backend = runWithSqliteWorkerStateContext(context, () =>
      createSqliteWorkerBackend(undefined, { databasePath: context.admission.databasePath }),
    );
    const database = openOpenClawStateDatabase();
    let committed = false;
    let cleanupFailed = false;
    const exec = database.db.exec.bind(database.db);
    vi.spyOn(database.db, "exec").mockImplementation((sql) => {
      exec(sql);
      committed ||= sql === "COMMIT";
    });
    const acquire = coordinator.acquireStateDatabaseCoordinator;
    vi.spyOn(coordinator, "acquireStateDatabaseCoordinator").mockImplementation((params) => {
      const lease = acquire(params);
      return {
        path: lease.path,
        get closed() {
          return lease.closed;
        },
        release() {
          lease.release();
          if (committed && !cleanupFailed) {
            cleanupFailed = true;
            throw new Error("Synthetic coordinator cleanup failure after commit");
          }
        },
      };
    });
    let result: unknown;
    let failure: unknown;
    try {
      result = runWithSqliteWorkerStateContext(context, () =>
        operation === "create"
          ? backend.execute({ type: "flows.createManaged", input: { flow } })
          : backend.execute({
              type: "flows.updateManaged",
              input: {
                flowId: flow.flowId,
                ownerKey: flow.ownerKey,
                expectedRevision: 0,
                patch: { status: "succeeded", updatedAt: 200, endedAt: 200 },
              },
            }),
      );
    } catch (error) {
      failure = error;
    } finally {
      vi.restoreAllMocks();
      await backend.close();
    }
    expect(cleanupFailed).toBe(true);
    const persisted = readTaskFlowRecord(openOpenClawStateDatabase().db, flow.flowId);
    expect(persisted).toMatchObject({
      flowId: flow.flowId,
      revision: operation === "create" ? 0 : 1,
      status: operation === "create" ? "queued" : "succeeded",
    });
    expect(failure).toBeUndefined();
    expect(result).toMatchObject(
      operation === "create"
        ? flow
        : {
            applied: true,
            flow: { flowId: flow.flowId, revision: 1, status: "succeeded", endedAt: 200 },
          },
    );
  },
);
