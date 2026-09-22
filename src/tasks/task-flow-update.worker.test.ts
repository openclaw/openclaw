import { afterEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { runWithSqliteWorkerStateContext } from "../infra/sqlite-worker-state-context.js";
import { captureStateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  bindTaskFlowRecord,
  readTaskFlowRecord,
  upsertTaskFlowRowInDatabase,
} from "./task-flow-registry.store.kernel.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRegistryWorkerOperations } from "./task-registry.worker-contract.js";
import { executeTaskRegistryCommand } from "./task-registry.worker.js";

const admission = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../infra/sqlite-worker-operation-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/sqlite-worker-operation-admission.js")>()),
  requestSqliteWorkerOperationAdmission: admission.request,
}));
afterEach(() => {
  vi.restoreAllMocks();
  admission.request.mockReset();
});

const flow: TaskFlowRecord = {
  flowId: "selected-flow",
  ownerKey: "agent:main:flow",
  syncMode: "managed",
  controllerId: "tests/selected-flow",
  status: "running",
  notifyPolicy: "done_only",
  goal: "Retain selected flow state",
  revision: 3,
  createdAt: 100,
  updatedAt: 250,
  stateJson: { payload: "x".repeat(16_384) },
  waitJson: { topic: "ready" },
};

async function withWorker(
  run: (fixture: {
    database: ReturnType<typeof openOpenClawStateDatabase>;
    execute: (command: SqliteWorkerCommand<TaskRegistryWorkerOperations>) => unknown;
  }) => void,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "flow-selected-update-" },
    async (state) => {
      const database = openOpenClawStateDatabase({ env: state.env });
      admission.request.mockImplementation(() => expect(database.db.isTransaction).toBe(true));
      run({
        database,
        execute: (command) =>
          runWithSqliteWorkerStateContext(
            {
              environment: { OPENCLAW_STATE_DIR: state.stateDir },
              coordinatorRuntime: captureStateDatabaseCoordinatorRuntime(),
            },
            () =>
              executeTaskRegistryCommand(
                command,
                { path: database.path, env: state.env },
                () => database,
              ),
          ),
      });
    },
  );
}

it("updates the selected managed flow once and rereads each later command", async () => {
  await withWorker(({ database, execute }) => {
    upsertTaskFlowRowInDatabase(database.db, bindTaskFlowRecord(flow));
    const observe = trackSqliteStatementExecutions(database.db, ["flows"], (sql) =>
      /\bfrom\s+"flow_runs"/i.test(sql) ? "flows" : null,
    );
    const update = (ownerKey: string, expectedRevision: number) =>
      execute({
        type: "flows.updateManaged",
        input: {
          flowId: flow.flowId,
          ownerKey,
          expectedRevision,
          patch: { currentStep: "next", updatedAt: 300 },
        },
      });
    try {
      expect(update(flow.ownerKey, 3)).toMatchObject({
        applied: true,
        previous: flow,
        flow: { ...flow, revision: 4, currentStep: "next", updatedAt: 300 },
      });
      expect(observe.counts.flows).toBeLessThanOrEqual(1);
      expect(observe.rowCounts.flows).toBe(1);
      expect(update("agent:main:other", 4)).toEqual({ applied: false, reason: "not_found" });
      expect(update(flow.ownerKey, 3)).toMatchObject({
        applied: false,
        reason: "revision_conflict",
        current: { revision: 4 },
      });
      upsertTaskFlowRowInDatabase(
        database.db,
        bindTaskFlowRecord({ ...flow, revision: 8, goal: "Changed by another command" }),
      );
      expect(update(flow.ownerKey, 8)).toMatchObject({
        applied: true,
        previous: { revision: 8, goal: "Changed by another command" },
        flow: { revision: 9, goal: "Changed by another command", stateJson: flow.stateJson },
      });
      expect(observe.counts.flows).toBeLessThanOrEqual(4);
    } finally {
      observe.restore();
    }
    expect(readTaskFlowRecord(database.db, flow.flowId)).toMatchObject({
      revision: 9,
      goal: "Changed by another command",
      stateJson: flow.stateJson,
      waitJson: flow.waitJson,
    });
  });
});

it.each(["repair", "cancel"] as const)(
  "maintains a selected flow with one read during %s",
  async (action) => {
    await withWorker(({ database, execute }) => {
      const stored: TaskFlowRecord =
        action === "repair"
          ? {
              ...flow,
              syncMode: "task_mirrored",
              controllerId: undefined,
              status: "failed",
              endedAt: 200,
            }
          : { ...flow, cancelRequestedAt: 150 };
      upsertTaskFlowRowInDatabase(database.db, bindTaskFlowRecord(stored));
      const observe = trackSqliteStatementExecutions(database.db, ["flows"], (sql) =>
        /\bfrom\s+"flow_runs"/i.test(sql) ? "flows" : null,
      );
      try {
        expect(
          execute({
            type: "flows.maintain",
            input: { flowId: flow.flowId, expectedRevision: 3, action, now: 400 },
          }),
        ).toBe("reconciled");
        expect(observe.counts.flows).toBeLessThanOrEqual(1);
        expect(observe.rowCounts.flows).toBe(1);
        expect(admission.request.mock.calls.map(([request]) => request.stage)).toEqual([
          "transaction",
          "commit",
        ]);
        expect(
          execute({
            type: "flows.maintain",
            input: { flowId: flow.flowId, expectedRevision: 3, action, now: 400 },
          }),
        ).toBe("revision_conflict");
      } finally {
        observe.restore();
      }
      expect(readTaskFlowRecord(database.db, flow.flowId)).toMatchObject({
        revision: 4,
        stateJson: flow.stateJson,
        status: action === "repair" ? "failed" : "cancelled",
        updatedAt: action === "repair" ? 200 : 400,
        endedAt: action === "repair" ? 200 : 400,
        waitJson: action === "repair" ? flow.waitJson : null,
      });
    });
  },
);
