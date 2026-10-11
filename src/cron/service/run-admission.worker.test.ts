import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  loseFirstCronMutationReply,
  observeCronStoreCommits,
} from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../../test-utils/agent-deletion-journal.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { clearCronJobActive } from "../active-jobs.js";
import { loadCronStore, saveCronStore, removeStaleCronJobFamilyRows } from "../store.js";
import * as cronStore from "../store.js";
import {
  findActiveCronRunReceiptInDatabase,
  finishCronRunReceiptAsync,
  CronRunReceiptConflictError,
  isCronRunReceiptOwnerStale,
  prepareCronRunReceiptClaim,
  trackCronRunReceiptSettlement,
} from "../store/run-receipt-store.js";
import { claimCronRunReceiptInDatabaseForTest } from "../store/run-receipt-store.test-support.js";
import { listForeignReceipts } from "./foreign-receipt-monitor.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  executeQueuedCronRun,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
  supersedeActivatedCronRun,
} from "./run-admission.js";
import * as runtimeMutation from "./runtime-mutation.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";

async function withReservation(
  run: (fixture: {
    state: ReturnType<typeof createCronRegressionState>;
    job: ReturnType<typeof createDueIsolatedJob>;
    identity: object;
    readReceipt: () => Record<string, unknown> | undefined;
    readJob: () => Promise<ReturnType<typeof createDueIsolatedJob> | undefined>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "cron-worker-admission" }, async (fixture) => {
    const now = 1_800_000_000_000;
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "owned-run", nowMs: now, nextRunAtMs: now });
    job.state.lastError = "previous occurrence error";
    const state = createCronRegressionState({
      storePath,
      defaultAgentId: "main",
      nowMs: () => now + 1_000,
      isAgentAvailable: () => true,
      runIsolatedAgentJob: async () => {
        throw new Error("Unexpected payload execution in reservation fixture");
      },
    });
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(state);
    const [reserved] = await persistQueuedCronRunReservations({
      state,
      candidates: [job],
      reservedAtMs: now,
    });
    if (!reserved) {
      throw new Error("Fixture failed to reserve run");
    }
    const identity = reserveQueuedCronRun(state, job.id, now, {
      runReceipt: reserved.runReceipt,
      runReceiptContext: reserved.runReceiptContext,
    });
    const db = openOpenClawStateDatabase();
    expect(db.path.startsWith(fixture.stateDir)).toBe(true);
    try {
      await run({
        state,
        job,
        identity,
        readJob: async () => (await loadCronStore(storePath)).jobs.find((row) => row.id === job.id),
        readReceipt: () =>
          db.db
            .prepare(
              "SELECT status, started_at_ms, error_text FROM cron_run_receipts WHERE receipt_id = ?",
            )
            .get(reserved.runReceipt.receiptId),
      });
    } finally {
      await cleanupQueuedCronRunReservations({
        state,
        reservations: [...state.queuedRunReservationsByJobId].map(([jobId, reservation]) => ({
          jobId,
          reservationIdentity: reservation.identity,
        })),
      });
      stop(state);
      await state.op;
    }
  });
}

it.each(["activation", "cleanup", "family", "worker control"] as const)(
  "services gateway events while cron %s waits for a writer",
  async (surface) => {
    await withReservation(async ({ state, job, identity, readJob }) => {
      const context = captureOpenClawStateWorkerContext();
      expect(context.admission.databasePath).toBe(openOpenClawStateDatabase().path);
      const holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 300);
      let pending: Promise<unknown> | undefined;
      try {
        await holder.ready;
        const heartbeat = nextTurn().then(() => Atomics.load(holder.released, 0));
        pending =
          surface === "activation"
            ? activateQueuedCronRun({ state, job, reservationIdentity: identity })
            : surface === "cleanup"
              ? cleanupQueuedCronRunReservations({
                  state,
                  reservations: [{ jobId: job.id, reservationIdentity: identity }],
                })
              : surface === "family"
                ? Promise.resolve(
                    removeStaleCronJobFamilyRows(state.deps.storePath, {
                      declarationKey: "synthetic",
                      name: "synthetic",
                      ownerPluginTag: "synthetic",
                    }),
                  )
                : recomputeUnownedCronSchedules(state);
        const releasedAtHeartbeat = await heartbeat;
        holder.release();
        const result = await pending;
        if (surface === "activation") {
          expect(result).toMatchObject({ kind: "activated", job: { id: job.id } });
        }
        if (surface === "cleanup") {
          expect((await readJob())?.state.queuedAtMs).toBeUndefined();
        }
        if (surface === "family") {
          expect(result).toBe(0);
        }
        expect(
          releasedAtHeartbeat,
          "gateway heartbeat must run before the holder's bounded fallback releases contention",
        ).toBe(0);
      } finally {
        holder.release();
        await holder.joined;
        await pending?.catch(() => undefined);
      }
    });
  },
);

it.each([false, true])(
  "preserves authored rows and SQL ownership when the worker reserves onExit=%s",
  async (onExit) => {
    await withOpenClawTestState({ label: "cron-reservation-authored-data" }, async (fixture) => {
      const now = 1_800_000_000_000;
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "legacy-reservation", nowMs: now, nextRunAtMs: now });
      job.schedule = onExit
        ? { kind: "on-exit", command: "true" }
        : { kind: "every", everyMs: 60_000 };
      const state = createCronRegressionState({
        storePath,
        defaultAgentId: "main",
        nowMs: () => now + 1_000,
        isAgentAvailable: () => true,
        runIsolatedAgentJob: async () => {
          throw new Error("Reservation must not execute the payload");
        },
      });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      const db = openOpenClawStateDatabase().db;
      const storeKey = path.resolve(storePath);
      db.prepare(
        "UPDATE cron_jobs SET agent_id = 'main', owner_agent_id = 'main', grant_definition_generation = 17, job_json = json_set(json_remove(job_json, '$.enabled'), '$.notify', json('true'), '$.isolation', json(?), '$.authoredNote', 'preserve me') WHERE store_key = ? AND job_id = ?",
      ).run(JSON.stringify({ legacy: "retained" }), storeKey, job.id);
      const raw = () =>
        db
          .prepare("SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = ?")
          .get(storeKey, job.id)?.job_json;
      const metadata = () =>
        db
          .prepare(
            "SELECT agent_id, owner_agent_id, sort_order, updated_at, grant_definition_revision, grant_definition_generation, grant_definition_updated_at FROM cron_jobs WHERE store_key = ? AND job_id = ?",
          )
          .get(storeKey, job.id);
      const before = raw();
      const metadataBefore = metadata();
      await list(state);
      const current = (await loadCronStore(storePath)).jobs[0]!;
      try {
        const reservations = await persistQueuedCronRunReservations({
          state,
          candidates: [current],
          reservedAtMs: now + 1_000,
          ...(onExit
            ? {
                manualRun: {
                  onExit: {
                    commitGuard: () => {},
                    onReserved: (reserved, runReceipt, runReceiptContext) => {
                      reserveQueuedCronRun(state, reserved.id, now + 1_000, {
                        runReceipt,
                        runReceiptContext,
                        onExit: true,
                      });
                    },
                  },
                },
              }
            : {}),
        });
        for (const reserved of reservations) {
          if (!state.queuedRunReservationsByJobId.has(reserved.job.id)) {
            reserveQueuedCronRun(state, reserved.job.id, now + 1_000, {
              runReceipt: reserved.runReceipt,
              runReceiptContext: reserved.runReceiptContext,
            });
          }
        }
        expect(reservations).toHaveLength(1);
        expect(metadata()).toEqual(metadataBefore);
        if (onExit) {
          expect(JSON.parse(String(raw()))).toEqual({
            ...JSON.parse(String(before)),
            enabled: false,
          });
        } else {
          expect(raw()).toBe(before);
        }
        expect(
          db
            .prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
            .get(storeKey, job.id),
        ).toEqual({ enabled: onExit ? 0 : 1 });
        const persisted = (await loadCronStore(storePath)).jobs[0]!;
        expect(persisted.state.queuedAtMs).toBe(now + 1_000);
        if (onExit) {
          expect(persisted.enabled).toBe(false);
          expect(persisted.state.nextRunAtMs).toBeUndefined();
        }
      } finally {
        try {
          await cleanupQueuedCronRunReservations({
            state,
            reservations: [...state.queuedRunReservationsByJobId].map(([jobId, reservation]) => ({
              jobId,
              reservationIdentity: reservation.identity,
            })),
          });
        } finally {
          stop(state);
          await state.op;
        }
      }
    });
  },
);

it("fences activation after replacement of its durable receipt", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const original = state.queuedRunReservationsByJobId.get(job.id)!.runReceipt;
    await finishCronRunReceiptAsync({
      handle: original,
      status: "interrupted",
      finishedAtMs: state.deps.nowMs(),
    });
    const prepared = prepareCronRunReceiptClaim({
      observed: undefined,
      storePath: state.deps.storePath,
      job,
      agentId: original.agentId,
      startedAtMs: original.startedAtMs,
    });
    const replacement = runOpenClawStateWriteTransaction(({ db }) =>
      claimCronRunReceiptInDatabaseForTest({
        database: db,
        prepared,
        resolveAgentId: () => original.agentId,
      }),
    );
    try {
      const before = await readJob();
      const receiptBefore = readReceipt();
      await expect(
        activateQueuedCronRun({ state, job, reservationIdentity: identity }),
      ).resolves.toEqual({ kind: "fenced" });
      expect(await readJob()).toEqual(before);
      expect(readReceipt()).toEqual(receiptBefore);
      expect(
        findActiveCronRunReceiptInDatabase({
          database: openOpenClawStateDatabase().db,
          storePath: state.deps.storePath,
          jobId: job.id,
        }),
      ).toEqual(replacement);
      expect(listForeignReceipts(state)).toEqual([]);
    } finally {
      await finishCronRunReceiptAsync({
        handle: replacement,
        status: "skipped",
        finishedAtMs: state.deps.nowMs(),
      });
    }
  });
});

it("rejects payload execution when its agent becomes unavailable after activation", async () => {
  await withReservation(async ({ state, job, identity }) => {
    let available = true;
    state.deps.isAgentAvailable = () => available;
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    state.deps.runIsolatedAgentJob = runner;
    let activeMarker: Parameters<typeof clearCronJobActive>[1];
    try {
      const result = await executeQueuedCronRun({
        state,
        jobId: job.id,
        reservedAtMs: state.queuedRunReservationsByJobId.get(job.id)!.markerAtMs,
        reservationIdentity: identity,
        onActivated: () => {
          available = false;
        },
        onNotRunnable: async () => {},
        onCompleted: async (outcome) => {
          activeMarker = outcome.activeJobMarker;
          return false;
        },
      });
      expect(result).toMatchObject({
        kind: "completed",
        outcome: {
          status: "error",
          error: "cron job agent is unavailable: main",
          receiptSettlementDisposition: "owner-unavailable",
        },
      });
      expect(runner).not.toHaveBeenCalled();
    } finally {
      if (activeMarker) {
        clearCronJobActive(job.id, activeMarker);
      }
    }
  });
});

it.each([false, true])(
  "cleans up activation stopped after commit unless its agent is deleting: deletion=%s",
  async (deleting) => {
    await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
      if (deleting) {
        const privateRoot = path.dirname(path.dirname(state.deps.storePath));
        beginAgentDeletionJournal({
          agentId: "main",
          operationId: "private-delete-main",
          deleteFiles: false,
          agentDir: path.join(privateRoot, "agents", "main", "agent"),
          workspaceDir: path.join(privateRoot, "workspace"),
          sessionsDir: path.join(privateRoot, "agents", "main", "sessions"),
        });
      }
      let stoppedAfterCommit = false;
      const stopObserving = observeCronStoreCommits(state.deps.storePath, () => {
        if (!stoppedAfterCommit && readReceipt()?.started_at_ms === state.deps.nowMs()) {
          stoppedAfterCommit = true;
          stop(state);
        }
      });
      try {
        const activation = activateQueuedCronRun({ state, job, reservationIdentity: identity });
        if (deleting) {
          await expect(activation).rejects.toThrow("cron job agent is unavailable: main");
        } else {
          await expect(activation).resolves.toEqual({ kind: "unavailable", reason: "stopped" });
        }
        expect(stoppedAfterCommit).toBe(true);
        const persisted = await readJob();
        if (deleting) {
          expect(persisted?.state.runningAtMs).toBe(1_800_000_001_000);
          expect(readReceipt()).toMatchObject({ status: "running" });
        } else {
          expect(persisted?.state.lastError).toBe("previous occurrence error");
          expect(persisted?.state.runningAtMs).toBeUndefined();
          expect(persisted?.state.queuedAtMs).toBeUndefined();
          expect(readReceipt()).toMatchObject({
            status: "skipped",
            error_text: "cron service stopped",
          });
          expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
        }
      } finally {
        stopObserving();
        if (deleting) {
          removeAgentDeletionJournal("main", "private-delete-main");
        }
      }
    });
  },
);

it.each(["submission", "publication"] as const)(
  "retains the runner fence when settlement completes at %s",
  async (timing) => {
    await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
      const activated = await activateQueuedCronRun({ state, job, reservationIdentity: identity });
      if (activated.kind !== "activated") {
        throw new Error("Fixture activation failed");
      }
      const runner = createDeferred();
      const finishErrors: unknown[] = [];
      trackCronRunReceiptSettlement({
        handle: activated.runReceipt,
        settlement: runner.promise,
        onFinishError: (error) => finishErrors.push(error),
      });
      let observedBoundary = false;
      const submit = runtimeMutation.runCronRuntimeMutation;
      const submission =
        timing === "submission"
          ? vi.spyOn(runtimeMutation, "runCronRuntimeMutation").mockImplementation((params) => {
              const pending = submit(params);
              if (!observedBoundary && params.type === "cron.releaseReservations") {
                observedBoundary = true;
                runner.resolve();
              }
              return pending;
            })
          : undefined;
      const stopObserving =
        timing === "publication"
          ? observeCronStoreCommits(state.deps.storePath, () => {
              observedBoundary = true;
            })
          : undefined;
      try {
        await supersedeActivatedCronRun({
          state,
          jobId: job.id,
          reservationIdentity: identity,
          runReceipt: activated.runReceipt,
          runReceiptContext: activated.runReceiptContext,
          reason: "retired occurrence",
        });
        expect(observedBoundary).toBe(true);
        if (timing === "publication") {
          expect(readReceipt()).toMatchObject({ status: "running" });
          runner.resolve();
        }
        await runner.promise;
        const persisted = await readJob();
        expect(persisted?.state.runningAtMs).toBeUndefined();
        expect(readReceipt()).toMatchObject({
          status: "superseded",
          error_text: "retired occurrence",
        });
        expect(finishErrors).toEqual([]);
      } finally {
        submission?.mockRestore();
        stopObserving?.();
        runner.resolve();
        await runner.promise;
        await readJob();
      }
    });
  },
);

it("publishes cleanup once without replay after a committed reply is lost", async () => {
  await withReservation(async ({ state, job, identity, readJob, readReceipt }) => {
    const reply = loseFirstCronMutationReply("cron.releaseReservations");
    try {
      await expect(
        cleanupQueuedCronRunReservations({
          state,
          reservations: [{ jobId: job.id, reservationIdentity: identity }],
        }),
      ).rejects.toBeInstanceOf(Error);
      await reply.waitForExit();
      expect(reply.wasDropped()).toBe(true);
      expect(reply.attempts).toEqual(["cron.releaseReservations"]);
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect((await readJob())?.state.queuedAtMs).toBeUndefined();
      expect(readReceipt()).toMatchObject({ status: "skipped" });
    } finally {
      await reply.close();
    }
  });
});

it.each(["lost reply", "postcommit conflict error"] as const)(
  "preserves recoverable reservations after %s without replay",
  async (failure) => {
    await withOpenClawTestState({ label: "cron-reservation-lost-reply" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "lost-reservation", nowMs: now, nextRunAtMs: now });
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        storePath,
        defaultAgentId: "main",
        nowMs: () => now,
        runIsolatedAgentJob: runner,
      });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      await list(state);
      const reply =
        failure === "lost reply" ? loseFirstCronMutationReply("cron.reserveRuns") : undefined;
      const publication =
        failure === "postcommit conflict error"
          ? vi.spyOn(cronStore, "noteCronJobsStoreCommit").mockImplementationOnce(() => {
              const receipt = runOpenClawStateWriteTransaction(({ db }) =>
                findActiveCronRunReceiptInDatabase({ database: db, storePath, jobId: job.id }),
              );
              if (!receipt) {
                throw new Error("Fixture publication did not follow its native commit");
              }
              throw new CronRunReceiptConflictError({
                ...receipt,
                status: "running",
                finishedAtMs: null,
              });
            })
          : undefined;
      try {
        await expect(
          persistQueuedCronRunReservations({ state, candidates: [job], reservedAtMs: now }),
        ).rejects.toBeInstanceOf(Error);
        if (reply) {
          await reply.waitForExit();
          expect(reply.wasDropped()).toBe(true);
          expect(reply.attempts).toEqual(["cron.reserveRuns"]);
        }
        expect(runner).not.toHaveBeenCalled();
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        expect(listForeignReceipts(state)).toEqual([]);
        const persisted = (await loadCronStore(storePath)).jobs[0]!;
        const receipt = findActiveCronRunReceiptInDatabase({
          database: openOpenClawStateDatabase().db,
          storePath,
          jobId: job.id,
        });
        if (failure === "lost reply") {
          expect(persisted.state.queuedAtMs).toBe(now);
          expect(receipt).toBeDefined();
          expect(isCronRunReceiptOwnerStale(receipt!)).toBe(true);
        } else {
          expect(persisted.state.queuedAtMs).toBeUndefined();
          expect(receipt).toBeUndefined();
          expect(
            openOpenClawStateDatabase()
              .db.prepare("SELECT status FROM cron_run_receipts WHERE job_id = ?")
              .all(job.id),
          ).toEqual([{ status: "skipped" }]);
        }
      } finally {
        await reply?.close();
        publication?.mockRestore();
        stop(state);
        await state.op;
      }
    });
  },
);

it("releases a settled receipt for recovery when its captured database admission retires", async () => {
  await withReservation(async ({ state, job, identity }) => {
    const ownership = state.queuedRunReservationsByJobId.get(job.id)!;
    const handle = ownership.runReceipt;
    const context = ownership.runReceiptContext;
    expect(isCronRunReceiptOwnerStale(handle)).toBe(false);
    await closeOpenClawStateDatabaseAsync();
    await expect(
      finishCronRunReceiptAsync(
        { handle, status: "skipped", finishedAtMs: 1_800_000_001_000 },
        context,
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(isCronRunReceiptOwnerStale(handle)).toBe(true);
    await expect(
      cleanupQueuedCronRunReservations({
        state,
        reservations: [{ jobId: job.id, reservationIdentity: identity }],
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
    const receipt = openOpenClawStateDatabase({ path: context.admission.databasePath })
      .db.prepare("SELECT status FROM cron_run_receipts WHERE receipt_id = ?")
      .get(handle.receiptId);
    expect(receipt).toEqual({ status: "running" });
  });
});
