// Register shared transport controls before the real pool and scope owners.
// oxfmt-ignore
import { input, nativePosts, observed, type NativeWorker } from "./session-transcript-worker-lanes.test-support.js";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { withSessionCostUsageWorkerDatabases } from "../../infra/session-cost-usage-worker-scope.js";
import type { UsageCostWorkerInput } from "../../infra/session-cost-usage-worker.types.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  costReadLane,
  costRefreshLane,
  rotateDatabaseWorkers,
} from "./session-transcript-worker-resources.js";

function usageRequest(operation: UsageCostWorkerInput["operation"]) {
  const { database } = input();
  const request: UsageCostWorkerInput = {
    kind: "usage-cost",
    location: {
      agentId: database.agentId,
      databasePath: database.path,
      storePath: database.path,
      env: {},
    },
    databases: [database],
    archiveStorePaths: [database.path],
    stores: [{ agentId: database.agentId, storePath: database.path, database }],
    operation,
  };
  return { database, request };
}

it.each(["read", "refresh"] as const)(
  "preserves the usage %s idle deadline when its outer scope finishes later",
  async (kind) => {
    const lane = kind === "read" ? costReadLane : costRefreshLane;
    const { database, request } = usageRequest(
      kind === "read" ? { kind: "inventory" } : { kind: "refresh", pricingFingerprint: "test" },
    );
    const taskFinished = createDeferredCore();
    const finishScope = createDeferredCore();
    const value =
      kind === "read" ? { kind: "inventory", files: [] } : { kind: "refresh", changed: false };
    nativePosts.observe = (worker, message) => {
      if (!message.input) {
        return;
      }
      queueMicrotask(() => {
        worker.emit("message", {
          status: "ok",
          taskId: message.taskId,
          value: { ok: true, value, closedDatabases: [database] },
        });
      });
    };
    const scope = withSessionCostUsageWorkerDatabases([database], async (owner) => {
      await owner.run(request, {});
      taskFinished.resolve();
      await finishScope.promise;
    });
    try {
      await awaitGateBeforeSettlement(taskFinished.promise, scope, "Usage task did not finish");
      await vi.advanceTimersByTimeAsync(20_000);
      finishScope.resolve();
      await scope;
      await vi.advanceTimersByTimeAsync(70_000 - 1);
      expect(lane.pool.getSnapshot().workers).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(lane.pool.getSnapshot().workers).toBe(0);
      expect(lane.native).toBe(false);
    } finally {
      finishScope.resolve();
      await scope;
      await rotateDatabaseWorkers(lane);
      nativePosts.observe = undefined;
    }
  },
);

it.each([false, true])(
  "retains usage registration through native cleanup retry (retry fails=%s)",
  async (retryFails) => {
    const { database, request } = usageRequest({ kind: "inventory" });
    const posted = createDeferredCore<NativeWorker>();
    const retryStarted = createDeferredCore();
    const allowExit = createDeferredCore();
    const firstStopFailure = new Error("native exit unconfirmed");
    const retryFailure = new Error("native exit still unconfirmed");
    const finalStopFailure = new Error("explicit cleanup retry failed");
    let stops = 0;
    const terminate = vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function (
      this: Worker,
    ) {
      if (++stops <= 2) {
        throw stops === 1 ? firstStopFailure : retryFailure;
      }
      retryStarted.resolve();
      await allowExit.promise;
      if (retryFails && stops === 3) {
        throw finalStopFailure;
      }
      this.emit("exit", 0);
      return 0;
    });
    nativePosts.observe = (worker, message) => {
      if (message.input && typeof message.input === "object" && "kind" in message.input) {
        posted.resolve(worker);
      }
    };
    const reading = withSessionCostUsageWorkerDatabases([database], (owner) =>
      owner.run(request, {}),
    );
    const outcome = reading.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      const worker = await awaitGateBeforeSettlement(
        posted.promise,
        outcome,
        "Usage scope ended before native dispatch",
      );
      worker.emit("error", new Error("usage transport failed"));
      await awaitGateBeforeSettlement(
        retryStarted.promise,
        outcome,
        "Usage scope released a database whose native close still needed retry",
      );
      expect(stops).toBe(3);
      expect(observed.unregister).not.toHaveBeenCalled();
      allowExit.resolve();
      const failure = await outcome;
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected original usage failure and its native cleanup error");
      }
      if (retryFails) {
        expect(failure.errors).toContain(finalStopFailure);
        expect(failure.errors[0]).toMatchObject({ errors: expect.arrayContaining([retryFailure]) });
        expect(observed.unregister).not.toHaveBeenCalled();
        await observed.resources.find((resource) => resource.agentId === database.agentId)!.close();
      } else {
        expect(failure.errors).toContain(retryFailure);
      }
      expect(observed.unregister).toHaveBeenCalledOnce();
    } finally {
      allowExit.resolve();
      await outcome;
      await rotateDatabaseWorkers(costReadLane);
      terminate.mockRestore();
      nativePosts.observe = undefined;
    }
  },
);
