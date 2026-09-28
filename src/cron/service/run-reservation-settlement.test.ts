import { expect, it, vi } from "vitest";
import {
  observeCronJobWrites,
  observeCronStoreCommits,
} from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { start, stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import { persistQueuedCronRunReservations, runWithCronAdmission } from "./run-admission.js";
import * as runHistory from "./run-history.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-reservation-settlement-",
});

it.each(["reservation", "timer", "startup"] as const)(
  "fences the old %s pass when stop and restart cross ownerless history persistence",
  async (entrypoint) => {
    const { storePath } = opsRegressionFixtures.makeStorePath();
    const now = Date.now();
    const ownerless = createDueIsolatedJob({
      id: "ownerless-history",
      nowMs: now - 2_000,
      nextRunAtMs: now - 1_000,
    });
    const owned = {
      ...createDueIsolatedJob({
        id: "owned-after-history",
        nowMs: now - 2_000,
        nextRunAtMs: now - 1_000,
      }),
      agentId: "alpha",
      payload: { kind: "command" as const, argv: ["echo", "synthetic"] },
    };
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const onEvent = vi.fn();
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      defaultAgentId: undefined,
      resolveDefaultAgentId: () => undefined,
      isAgentAvailable: () => true,
      runCommandJob: runner,
      runIsolatedAgentJob: runner,
      onEvent,
    });
    await saveCronStore(storePath, { version: 1, jobs: [ownerless, owned] });
    await list(state);
    onEvent.mockClear();
    const entered = createDeferred();
    const release = createDeferred();
    let observed = false;
    const finish = runHistory.finishCronRun;
    const history = vi.spyOn(runHistory, "finishCronRun").mockImplementation(async (...args) => {
      if (args[1].ownerlessRun && args[1].event.jobId === ownerless.id) {
        observed = true;
        entered.resolve();
        await release.promise;
      }
      await finish(...args);
    });
    const pending =
      entrypoint === "reservation"
        ? persistQueuedCronRunReservations({
            state,
            candidates: [ownerless, owned],
            reservedAtMs: now,
          })
        : entrypoint === "timer"
          ? onTimer(state)
          : start(state);
    void pending.then(
      () => entered.resolve(),
      () => entered.resolve(),
    );
    try {
      await entered.promise;
      expect(observed).toBe(true);
      stop(state);
      // A disabled restart changes the generation without admitting successor work.
      state.deps.cronEnabled = false;
      await start(state);
      expect(state.stopped).toBe(false);
      release.resolve();
      const result = await pending;
      if (entrypoint === "reservation") {
        expect(result).toEqual([]);
      }
      expect(runner).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(storePath)).jobs;
      expect(persisted.find((job) => job.id === owned.id)?.state).toEqual(owned.state);
      expect(persisted.find((job) => job.id === ownerless.id)?.state).toMatchObject({
        lastRunStatus: "skipped",
        lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      });
      expect(
        openOpenClawStateDatabase()
          .db.prepare("SELECT receipt_id FROM cron_run_receipts WHERE store_key = ?")
          .all(cronStoreKey(storePath)),
      ).toEqual([]);
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: ownerless.id })
          .entries,
      ).toEqual([expect.objectContaining({ jobId: ownerless.id, status: "skipped" })]);
      expect(
        onEvent.mock.calls.map(([event]) => event).filter((event) => event.action === "finished"),
      ).toEqual([expect.objectContaining({ jobId: ownerless.id, status: "skipped" })]);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(state.runAdmission.active).toBe(0);
      expect(state.activeTimerTicks).toBe(0);
    } finally {
      release.resolve();
      await pending.catch(() => undefined);
      history.mockRestore();
      stop(state);
      await state.op;
    }
  },
);

it.each([
  { trigger: "manual", restartScheduler: false },
  { trigger: "scheduled", restartScheduler: false },
  { trigger: "startup", restartScheduler: false },
  { trigger: "scheduled", restartScheduler: true },
] as const)(
  "retries $trigger cleanup when stop follows the committed reservation (restart: $restartScheduler)",
  async ({ trigger, restartScheduler }) => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.250Z");
    const job = createDueIsolatedJob({
      id: `stopped-during-${trigger}-reservation`,
      nowMs: dueAt,
      nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => dueAt,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const releaseSuccessor = createDeferred();
    let restarted: Promise<void> | undefined;
    let successorAdmission: Promise<unknown> | undefined;
    let reservationPersisted = false;
    let cleanupFailed = false;
    const stopObserving = observeCronJobWrites(job.id, ({ queuedAtMs }) => {
      if (reservationPersisted && !cleanupFailed && queuedAtMs === undefined) {
        cleanupFailed = true;
        throw new Error("reservation cleanup persist failed");
      }
    });
    const database = openOpenClawStateDatabase().db;
    const stopObservingCommits = observeCronStoreCommits(store.storePath, () => {
      const queued = database
        .prepare(
          "SELECT 1 FROM cron_jobs WHERE store_key = ? AND job_id = ? AND json_extract(state_json, '$.queuedAtMs') = ?",
        )
        .get(cronStoreKey(store.storePath), job.id, dueAt);
      if (!reservationPersisted && queued) {
        reservationPersisted = true;
        stop(state);
        if (restartScheduler) {
          restarted = start(state);
          successorAdmission = runWithCronAdmission(state, () => releaseSuccessor.promise);
        }
      }
    });

    try {
      if (trigger === "manual") {
        await expect(run(state, job.id, "force")).resolves.toEqual({
          ok: true,
          ran: false,
          reason: "stopped",
        });
      } else if (trigger === "scheduled") {
        await onTimer(state);
      } else {
        await expect(runMissedJobs(state)).rejects.toThrow("reservation cleanup persist failed");
      }
      await restarted;
      expect(state.stopped).toBe(!restartScheduler);
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(reservationPersisted && cleanupFailed).toBe(true);
      expect(state.runAdmission.active).toBe(restartScheduler ? 1 : 0);
      expect(state.deps.runIsolatedAgentJob).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
    } finally {
      stopObservingCommits();
      stopObserving();
      releaseSuccessor.resolve();
      await Promise.allSettled([restarted, successorAdmission]);
      stop(state);
    }
    expect(state.runAdmission.active).toBe(0);
  },
);
