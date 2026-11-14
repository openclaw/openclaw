import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  nextEventLoopTurn,
  withinTest,
} from "../../../test/helpers/promise.js";
import * as sqliteTransactions from "../../infra/sqlite-transaction.js";
import { holdCreatedFileCallback } from "../../infra/sqlite-worker-fixture.test-support.js";
import * as operationAdmissions from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { seedOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.test-support.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveQuarantineStorePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  withSqliteMutationWorkerCoordination as coordinateWorker,
  withSqliteWorkerLifecycleCoordination as coordinateLifecycle,
} from "./session-accessor.sqlite-worker-coordination.js";

function withWorkerState(label: string, run: (state: OpenClawTestState) => Promise<void>) {
  return withOpenClawTestState({ scenario: "external-service", label }, async (state) => {
    openOpenClawStateDatabase();
    await run(state);
  });
}

function createCoordinationWorker(
  state: OpenClawTestState,
  operation: string,
  release: Int32Array,
  agentPath = state.path(operation, "openclaw-agent.sqlite"),
) {
  return new Worker(
    new URL(
      "./session-accessor.sqlite-worker-coordination.worker.test-support.mjs",
      import.meta.url,
    ),
    {
      execArgv: [],
      workerData: {
        operation,
        release: release.buffer,
        agentPath,
        sourceLoaderUrl: import.meta.resolve("tsx/esm/api"),
      },
    },
  );
}

it("admits a host profile write while reconciliation publishes a cold quarantine fact", async () => {
  await withWorkerState("reconcile-cold-quarantine", async (state) => {
    seedOpenClawDatabaseQuarantine({
      path: state.path("unrelated.sqlite"),
      kind: "agent",
      reason: "synthetic unrelated damage",
    });
    const context = captureOpenClawStateWorkerContext();
    const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    // Task workers also have a general metadata relay. The lifecycle channel
    // must win when a synchronous host write needs to service the lock holder.
    const fallback = operationAdmissions.createSqliteDatabaseAdmissionRelay(() => {});
    const worker = createCoordinationWorker(
      state,
      "cold-quarantine",
      release,
      state.path("cold.sqlite"),
    );
    try {
      await coordinateLifecycle(
        context,
        "cold-quarantine",
        async (coordination) => {
          const held = once(worker, "message");
          const exited = once(worker, "exit");
          worker.postMessage({ ...coordination, fallbackAdmission: fallback.port }, [
            fallback.port,
            ...(coordination.databaseAdmission ? [coordination.databaseAdmission] : []),
          ]);
          expect(await held).toEqual(["held"]);
          const finished = once(worker, "message");
          Atomics.store(release, 0, 1);
          Atomics.notify(release, 0);
          const profile = ensureProfileForEmail("concurrent@example.test");
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT profile_id FROM user_profile_emails WHERE email = ?")
              .get("concurrent@example.test"),
          ).toEqual({ profile_id: profile.id });
          expect(await finished).toEqual(["checked"]);
          expect(await exited).toEqual([0]);
        },
        async () => {
          await worker.terminate();
        },
        "reconciliation",
      );
    } finally {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      await worker.terminate();
      await fallback.finish();
    }
  });
});

it("allows accepted cleanup after the close owner revokes new reads", async () => {
  await withWorkerState("mutation-worker-retained-close", async () => {
    const context = captureOpenClawStateWorkerContext();
    const close = vi.fn(async () => "closed");
    let attempted = false;
    const unregister = registerOpenClawStateDatabaseAsyncResource({
      close: async () => {
        // A failed assertion must not strand the test's own close resource.
        if (attempted) {
          return;
        }
        attempted = true;
        expect(() => context.admission.assertCurrent()).toThrow(/read admission is closed/);
        await expect(
          coordinateLifecycle(context, "retained-close", close, async () => {}),
        ).resolves.toBe("closed");
      },
    });
    try {
      await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
      expect(close).toHaveBeenCalledOnce();
    } finally {
      unregister();
    }
  });
});

it("admits another agent lease while a sibling worker retains process ownership", async () => {
  await withWorkerState("mutation-worker-parallel-leases", async (state) => {
    const context = captureOpenClawStateWorkerContext();
    const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const holder = createCoordinationWorker(state, "hold", release);
    const claimant = createCoordinationWorker(state, "lease", release);
    const workers = [holder, claimant];
    const dispatch = (worker: Worker, result: "held" | "claimed") =>
      coordinateWorker(context, { kind: "dedicated", channel: worker }, 1, async (coordination) => {
        const completed = Promise.all([once(worker, "message"), once(worker, "exit")]);
        worker.postMessage(coordination, []);
        expect(await completed).toEqual([[result], [0]]);
      });
    const held = once(holder, "message");
    const holding = dispatch(holder, "held");
    try {
      expect(await held).toEqual(["held"]);
      await dispatch(claimant, "claimed");
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT count(*) AS count FROM agent_database_leases")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      Atomics.store(release, 0, 1);
      Atomics.notify(release, 0);
      try {
        await holding;
      } finally {
        await Promise.all(workers.map((worker) => worker.terminate()));
      }
    }
  });
});

it("joins native worker exit before rejecting failed dispatch", async () => {
  await withWorkerState("mutation-worker-preparation", async () => {
    const context = captureOpenClawStateWorkerContext();
    const worker = new Worker(
      'require("node:worker_threads").parentPort.on("message", () => {});',
      { eval: true, execArgv: [] },
    );
    const failure = new Error("Synthetic worker dispatch failure");
    try {
      await once(worker, "online");
      await expect(
        coordinateWorker(context, { kind: "dedicated", channel: worker }, 1, async () => {
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(worker.threadId).toBe(-1);
    } finally {
      await worker.terminate();
    }
  });
});

it.for([false, true])(
  "joins an accepted companion CREATE after worker exit (run fails: %s)",
  async (failRun, { signal }) => {
    await withWorkerState("coordination-accepted-create", async (state) => {
      const context = captureOpenClawStateWorkerContext();
      const quarantinePath = resolveQuarantineStorePath(context.environment);
      expect(fs.existsSync(quarantinePath)).toBe(false);
      using creation = holdCreatedFileCallback(quarantinePath);
      const createAdmission = operationAdmissions.createSqliteWorkerOperationAdmission;
      let admission: ReturnType<typeof createAdmission> | undefined;
      using construction = vi
        .spyOn(operationAdmissions, "createSqliteWorkerOperationAdmission")
        .mockImplementation((...args) => {
          admission = createAdmission(...args);
          return admission;
        });
      const release = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      const worker = createCoordinationWorker(state, "create-quarantine", release);
      const runEnded = createDeferredCore();
      const failure = new Error("Synthetic coordination operation failure");
      const completed = vi.fn();
      const serviceReleased = vi.fn();
      const retainService = sqliteTransactions.retainSqliteWriteAdmissionService;
      using registration = vi
        .spyOn(sqliteTransactions, "retainSqliteWriteAdmissionService")
        .mockImplementation((locations, service) => {
          const releaseService = retainService(locations, service);
          return () => {
            releaseService();
            serviceReleased();
          };
        });
      const operation = coordinateLifecycle(
        context,
        "accepted-companion-creation",
        async (coordination) => {
          const exited = once(worker, "exit");
          worker.postMessage(
            coordination,
            coordination.databaseAdmission ? [coordination.databaseAdmission] : [],
          );
          await awaitGateBeforeSettlement(
            creation.entered,
            exited,
            "Worker exited before requesting actual companion creation",
          );
          await worker.terminate();
          await exited;
          runEnded.resolve();
          if (failRun) {
            throw failure;
          }
          return "completed run";
        },
        async () => {
          await worker.terminate();
        },
        "retained",
        () => context.admission.assertCurrent(),
      );
      const outcome = Promise.allSettled([operation]).then((result) => {
        completed();
        return result;
      });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            creation.entered,
            operation,
            "Coordination bypassed actual companion creation",
          ),
          signal,
        );
        assert(creation.descriptor !== undefined, "Expected the actual successful wx descriptor");
        expect(fs.fstatSync(creation.descriptor).size).toBe(0);
        expect(fs.statSync(quarantinePath).size).toBe(0);
        await withinTest(
          awaitGateBeforeSettlement(
            runEnded.promise,
            operation,
            "Coordination settled before its worker exited",
          ),
          signal,
        );
        await nextEventLoopTurn();
        expect(worker.threadId).toBe(-1);
        expect(construction).toHaveBeenCalledOnce();
        expect(registration).toHaveBeenCalledOnce();
        expect(completed).not.toHaveBeenCalled();
        expect(serviceReleased).not.toHaveBeenCalled();
        creation.release();
        if (failRun) {
          await expect(withinTest(operation, signal)).rejects.toBe(failure);
        } else {
          await expect(withinTest(operation, signal)).resolves.toBe("completed run");
        }
        await outcome;
        expect(serviceReleased).toHaveBeenCalledOnce();
        expect(fs.existsSync(quarantinePath)).toBe(true);
        expect(fs.statSync(quarantinePath).size).toBe(0);
      } finally {
        creation.release();
        await worker.terminate();
        try {
          await outcome;
        } finally {
          // The old coordinator drops this join; the negative control must not leak its CREATE.
          await admission?.finish();
        }
      }
    });
  },
);
