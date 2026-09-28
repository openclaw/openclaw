import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../../test-utils/state-database-contention.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { start, stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import * as runAdmission from "./run-admission.js";
import { onTimer } from "./timer.test-support.js";

it.each(["manual", "timer", "startup"] as const)(
  "keeps gateway events responsive while a successful %s run waits to reserve its receipt",
  async (entrypoint) => {
    await withOpenClawTestState(
      { label: "cron-successful-reservation-contention" },
      async (fixture) => {
        const now = Date.now();
        const storePath = fixture.statePath("cron", "jobs.json");
        const job = createDueIsolatedJob({
          id: "contended-reservation",
          nowMs: now - 2_000,
          nextRunAtMs: now - 1_000,
        });
        job.payload = { kind: "command", argv: ["echo", "synthetic"] };
        const runner = vi.fn(async () => ({ status: "ok" as const }));
        const state = createCronRegressionState({
          storePath,
          nowMs: () => now,
          defaultAgentId: "main",
          isAgentAvailable: () => true,
          runCommandJob: runner,
          runIsolatedAgentJob: runner,
        });
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        await list(state);
        const context = captureOpenClawStateWorkerContext();
        const reserve = runAdmission.persistQueuedCronRunReservations;
        let observed = 0;
        let releasedAtHeartbeat: number | undefined;
        const admission = vi
          .spyOn(runAdmission, "persistQueuedCronRunReservations")
          .mockImplementation(async (params) => {
            observed += 1;
            // Acquire after caller preflight, so an earlier asynchronous read cannot satisfy the oracle.
            const holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 300);
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
          });
        try {
          const result = await (entrypoint === "manual"
            ? run(state, job.id, "force")
            : entrypoint === "timer"
              ? onTimer(state)
              : start(state));
          expect(observed).toBe(1);
          expect(
            releasedAtHeartbeat,
            "gateway heartbeat must run before the held database's bounded fallback releases the writer",
          ).toBe(0);
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
          expect(state.queuedRunReservationsByJobId.size).toBe(0);
          expect(state.runAdmission.active).toBe(0);
        } finally {
          admission.mockRestore();
          stop(state);
          await state.op;
        }
      },
    );
  },
);
