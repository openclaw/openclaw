import { setImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import type { SqliteWorkerAdmissionFactory } from "../infra/sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "../infra/sqlite-worker-operation-settlement.js";
import { StateDatabaseCoordinatorContentionError } from "../infra/state-database-coordinator.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { syncLiveTaskFlowWithWorker } from "./task-registry-live-flow-sync.js";
import type { TaskLiveFlowSyncOutcome } from "./task-registry.store.types.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: run,
}));
afterEach(() => run.mockReset());

const context: OpenClawStateWorkerContext = {
  environment: { OPENCLAW_STATE_DIR: "/synthetic/live-task-state" },
  coordinatorRuntime: { directory: "/synthetic/live-task-coordinator", keepAlive: false },
  admission: {
    databasePath: "/synthetic/live-task-state/openclaw.sqlite",
    identity: {
      key: "file:synthetic",
      canonicalPath: "/synthetic/live-task-state/openclaw.sqlite",
    },
    assertCurrent() {},
  },
};
const params = { taskId: "live-task", flowId: "live-flow" };
type LiveCommand = { type: "flows.syncLiveMirroredTask"; input: typeof params };

it("preserves a coordinator assertion failure at factory entry", async () => {
  const failure = new StateDatabaseCoordinatorContentionError("state-lifecycle");
  const assertCurrent = vi.fn().mockImplementationOnce(() => {
    throw failure;
  });
  run.mockImplementationOnce(
    async (
      _context: OpenClawStateWorkerContext,
      _operation: unknown,
      options: { createAdmission: SqliteWorkerAdmissionFactory },
    ) => {
      const held = options.createAdmission({
        settled: Promise.resolve({ kind: "not-entered", error: failure }),
      });
      held.admission.finish();
      throw new Error("Expected factory assertion to refuse");
    },
  );
  await expect(
    syncLiveTaskFlowWithWorker(context, params, { assertCurrent, isSelected: () => true }),
  ).rejects.toBe(failure);
});

it("retries coordinator contention only before admission factory entry", async () => {
  const failure = new StateDatabaseCoordinatorContentionError("state-lifecycle");
  const authority = { assertCurrent() {}, isSelected: () => true };
  run.mockRejectedValueOnce(failure);
  await expect(syncLiveTaskFlowWithWorker(context, params, authority)).resolves.toEqual({
    kind: "retry",
    reason: "storage_contention",
  });
  run.mockImplementationOnce(
    async (
      _context: OpenClawStateWorkerContext,
      _operation: unknown,
      options: { createAdmission: SqliteWorkerAdmissionFactory },
    ) => {
      const held = options.createAdmission({ settled: Promise.resolve({ kind: "completed" }) });
      held.admission.finish();
      throw failure;
    },
  );
  await expect(syncLiveTaskFlowWithWorker(context, params, authority)).rejects.toBe(failure);
});

it.each(["completed refusal", "cleanup aggregate", "unknown settlement"] as const)(
  "classifies exact live selection refusal after %s",
  async (boundary) => {
    const native = createDeferred<SqliteWorkerOperationSettlement>();
    const observed = createDeferred();
    const complete = createDeferred();
    let deliveredFailure: unknown;
    run.mockImplementation(
      async (
        captured: OpenClawStateWorkerContext,
        operation: (scope: {
          execute(command: LiveCommand): Promise<TaskLiveFlowSyncOutcome>;
        }) => Promise<TaskLiveFlowSyncOutcome>,
        options: { requireStateLifecycle: boolean; createAdmission: SqliteWorkerAdmissionFactory },
      ) => {
        expect(captured).toBe(context);
        expect(options.requireStateLifecycle).toBe(true);
        const { admission, nativeLocations } = options.createAdmission({ settled: native.promise });
        expect(nativeLocations).toEqual([context.admission.databasePath]);
        try {
          return await operation({
            async execute(command) {
              expect(command).toEqual({ type: "flows.syncLiveMirroredTask", input: params });
              const decision = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
              admission.port.postMessage(
                {
                  stage: "transaction",
                  facts: { kind: "task-live-flow", ...params, createdAt: 10 },
                  decision: decision.buffer,
                },
                [],
              );
              await setImmediate();
              admission.service();
              expect(Atomics.load(decision, 0)).toBe(2);
              const refusal = expectDefined(admission.failure, "live selection refusal");
              deliveredFailure =
                boundary === "completed refusal"
                  ? refusal
                  : boundary === "cleanup aggregate"
                    ? new AggregateError([refusal, new Error("Controlled cleanup failure")])
                    : new SqliteWorkerError("Controlled unknown outcome", "outcome-unknown");
              observed.resolve();
              await complete.promise;
              throw deliveredFailure;
            },
          });
        } finally {
          admission.finish();
        }
      },
    );
    const result = syncLiveTaskFlowWithWorker(context, params, {
      assertCurrent() {},
      isSelected: () => false,
    });
    const outcome = result.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await observed.promise;
      native.resolve(
        boundary === "unknown settlement"
          ? { kind: "unknown", error: deliveredFailure }
          : { kind: "completed" },
      );
      complete.resolve();
      expect(await outcome).toEqual(
        boundary === "completed refusal"
          ? { value: { kind: "not-selected" } }
          : { error: deliveredFailure },
      );
    } finally {
      native.resolve({ kind: "completed" });
      complete.resolve();
      await outcome;
    }
  },
);
