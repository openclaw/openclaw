import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseCoordinator } from "../../test-utils/state-database-contention.js";
import { saveCronStore, loadCronStore, removeStaleCronJobFamilyRows } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import {
  activateQueuedCronRun,
  cleanupQueuedCronRunReservations,
  persistQueuedCronRunReservations,
  reserveQueuedCronRun,
} from "./run-admission.js";
import { recomputeUnownedCronSchedules } from "./schedule-maintenance.js";

it.each(["activation", "cleanup", "family", "worker control"] as const)(
  "services gateway events while cron %s waits for a writer",
  async (surface) => {
    await withOpenClawTestState({ label: "cron-worker-responsiveness" }, async (fixture) => {
      const now = 1_800_000_000_000;
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "contended-cron", nowMs: now, nextRunAtMs: now });
      const state = createCronRegressionState({
        storePath,
        nowMs: () => now,
        defaultAgentId: "main",
        runIsolatedAgentJob: async () => {
          throw new Error("Unexpected payload execution in database responsiveness fixture");
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
        throw new Error("Fixture reservation was not committed");
      }
      const identity = reserveQueuedCronRun(state, job.id, now, {
        runReceipt: reserved.runReceipt,
      });
      const context = captureOpenClawStateWorkerContext();
      expect(context.admission.databasePath.startsWith(fixture.stateDir)).toBe(true);
      const holder = holdStateDatabaseCoordinator(
        context.admission.databasePath,
        context.coordinatorRuntime,
        300,
      );
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
                    removeStaleCronJobFamilyRows(storePath, {
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
          expect((await loadCronStore(storePath)).jobs[0]?.state.queuedAtMs).toBeUndefined();
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
        await cleanupQueuedCronRunReservations({
          state,
          reservations: [{ jobId: job.id, reservationIdentity: identity }],
        });
        stop(state);
        await state.op;
      }
    });
  },
);
