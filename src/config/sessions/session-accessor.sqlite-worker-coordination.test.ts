import { once } from "node:events";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createSqliteDatabaseAdmissionRelay } from "../../infra/sqlite-worker-operation-admission.js";
import { seedOpenClawDatabaseQuarantine } from "../../state/openclaw-quarantine-store.test-support.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
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
    const fallback = createSqliteDatabaseAdmissionRelay(() => {});
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
      fallback.finish();
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
