import { setImmediate as nextTurn } from "node:timers/promises";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../../test/helpers/sqlite-parent-observer.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { start, stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import * as runAdmission from "./run-admission.js";
import * as runtimeMutation from "./runtime-mutation.js";
import { onTimer } from "./timer.test-support.js";

it.each([
  { phase: "finalization", entrypoint: "manual" },
  { phase: "reservation", entrypoint: "manual" },
  { phase: "reservation", entrypoint: "timer" },
  { phase: "reservation", entrypoint: "startup" },
] as const)(
  "services gateway events while $entrypoint $phase waits for a writer",
  async ({ phase, entrypoint }) => {
    await withOpenClawTestState({ label: `cron-${phase}-contention` }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({
        id: `contended-${phase}`,
        nowMs: now - 2_000,
        nextRunAtMs: now - 1_000,
      });
      job.payload = { kind: "command", argv: ["echo", "synthetic"] };
      const runner = vi.fn(async () => {
        // Admission is complete; count the entire tail through finalization and cleanup.
        sql?.reset();
        return { status: "ok" as const };
      });
      const onEvent = vi.fn();
      const state = createCronRegressionState({
        storePath,
        nowMs: () => now,
        defaultAgentId: "main",
        isAgentAvailable: () => true,
        runCommandJob: runner,
        runIsolatedAgentJob: runner,
        onEvent,
      });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      await list(state);
      const context = captureOpenClawStateWorkerContext();
      const sql =
        phase === "reservation" && entrypoint !== "startup" ? observeParentSqlite() : undefined;
      const execute = runtimeMutation.runCronRuntimeMutation;
      const reserve = runAdmission.persistQueuedCronRunReservations;
      let observed = 0;
      let releasedAtHeartbeat: number | undefined;
      let settledAtHeartbeat: boolean | undefined;
      const mutation =
        phase === "finalization"
          ? vi
              .spyOn(runtimeMutation, "runCronRuntimeMutation")
              .mockImplementation(async (params) => {
                if (params.type !== "cron.finalizeRuns") {
                  return execute(params);
                }
                observed += 1;
                // Acquire only at finalization, after outcome history and caller preflight have finished.
                const holder = holdStateDatabaseWriteTransaction(
                  params.context.admission.databasePath,
                );
                const posted = createDeferred();
                let pending: Promise<void> | undefined;
                let settled = false;
                let postedRequestId: number | undefined;
                // oxlint-disable-next-line typescript/unbound-method -- Preserve the real Worker receiver.
                const nativePost = Worker.prototype.postMessage;
                const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
                  this: Worker,
                  request: SqliteWorkerRequest,
                  transferList,
                ) {
                  const command: unknown =
                    request.type === "execute" ? deserialize(request.input) : undefined;
                  nativePost.call(this, request, transferList);
                  if (
                    isRecord(command) &&
                    command.type === "cron.finalizeRuns" &&
                    isRecord(command.input) &&
                    Array.isArray(command.input.jobIds) &&
                    command.input.jobIds.includes(job.id)
                  ) {
                    postedRequestId = request.id;
                    posted.resolve();
                  }
                });
                try {
                  await holder.ready;
                  pending = execute(params);
                  void pending.then(
                    () => {
                      settled = true;
                    },
                    () => {
                      settled = true;
                    },
                  );
                  await Promise.race([
                    posted.promise,
                    pending.then(() => {
                      throw new Error("Finalization completed without its real worker dispatch");
                    }),
                  ]);
                  expect(postedRequestId).toBeDefined();
                  await nextTurn();
                  releasedAtHeartbeat = Atomics.load(holder.released, 0);
                  settledAtHeartbeat = settled;
                  holder.release();
                  return await pending;
                } finally {
                  holder.release();
                  try {
                    try {
                      await holder.joined;
                    } finally {
                      await pending?.catch(() => undefined);
                    }
                  } finally {
                    post.mockRestore();
                  }
                }
              })
          : undefined;
      const admission =
        phase === "reservation"
          ? vi
              .spyOn(runAdmission, "persistQueuedCronRunReservations")
              .mockImplementation(async (params) => {
                observed += 1;
                // Acquire after caller preflight, so an earlier asynchronous read cannot satisfy the oracle.
                const holder = holdStateDatabaseWriteTransaction(
                  context.admission.databasePath,
                  300,
                );
                let pending: ReturnType<typeof reserve> | undefined;
                try {
                  await holder.ready;
                  const heartbeat = nextTurn().then(() => Atomics.load(holder.released, 0));
                  pending = reserve(params);
                  releasedAtHeartbeat = await heartbeat;
                  holder.release();
                  return await pending;
                } finally {
                  holder.release();
                  await holder.joined;
                  await pending?.catch(() => undefined);
                }
              })
          : undefined;
      try {
        if (sql) {
          const database = new (requireNodeSqlite().DatabaseSync)(":memory:");
          try {
            database.exec("CREATE TABLE calibration (value INTEGER)");
            database.prepare("INSERT INTO calibration VALUES (?)").run(1);
            const query = database.prepare("SELECT value FROM calibration");
            query.get();
            query.all();
            expect([...query.iterate()]).toHaveLength(1);
          } finally {
            database.close();
          }
          expect(Object.values(sql.counts).every((count) => count > 0)).toBe(true);
        }
        const result = await (entrypoint === "manual"
          ? run(state, job.id, "force")
          : entrypoint === "timer"
            ? onTimer(state)
            : start(state));
        const counts = sql ? { ...sql.counts } : undefined;
        sql?.restore();
        expect(observed).toBe(1);
        expect(
          releasedAtHeartbeat,
          "gateway heartbeat must run before the held database's bounded fallback releases the writer",
        ).toBe(0);
        if (phase === "finalization") {
          expect(settledAtHeartbeat).toBe(false);
        }
        if (entrypoint === "manual") {
          expect(result).toMatchObject({ ok: true, ran: true });
        }
        expect(runner).toHaveBeenCalledOnce();
        const persisted = (await loadCronStore(storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(persisted?.state.lastRunStatus).toBe("ok");
        expect(persisted?.state.queuedAtMs).toBeUndefined();
        expect(persisted?.state.runningAtMs).toBeUndefined();
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        expect(
          openOpenClawStateDatabase()
            .db.prepare("SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
            .get(cronStoreKey(storePath), job.id),
        ).toEqual({ status: "ok" });
        expect(
          onEvent.mock.calls
            .filter(([event]) => event.action === "finished")
            .map(([event]) => event),
        ).toEqual([expect.objectContaining({ jobId: job.id, status: "ok" })]);
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        expect(state.runAdmission.active).toBe(0);
        if (sql) {
          expect(counts).toEqual(emptySqliteCounts());
        }
      } finally {
        sql?.restore();
        mutation?.mockRestore();
        admission?.mockRestore();
        stop(state);
        await state.op;
      }
    });
  },
);
