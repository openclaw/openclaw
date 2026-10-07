import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import {
  loseFirstCronMutationReply,
  observeCronJobWrites,
  observeCronStoreCommits,
  terminateFirstCronMutationBeforeCommit,
} from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { isCronRunReceiptOwnerStale } from "../store/run-receipt-store.js";
import type { CronRunReceiptHandle } from "../store/run-receipt.types.js";
import { start, stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";
import * as admissionMutation from "./run-admission-mutation.js";
import { persistQueuedCronRunReservations, runWithCronAdmission } from "./run-admission.js";
import * as runHistory from "./run-history.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-reservation-settlement-",
});

it.each(["startup", "scheduled"] as const)(
  "releases exact local %s ownership after real unknown cleanup settlement without replay",
  async (entrypoint) => {
    await withOpenClawTestState(
      { label: `cron-${entrypoint}-unknown-cleanup` },
      async (fixture) => {
        await closeOpenClawStateDatabaseAsync();
        const fault = terminateFirstCronMutationBeforeCommit("cron.releaseReservations");
        const storePath = fixture.statePath("cron", "jobs.json");
        const now = Date.now();
        const futureAt = now + 60_000;
        const job = createDueIsolatedJob({
          id: `unknown-${entrypoint}-cleanup`,
          nowMs: now,
          nextRunAtMs: now,
        });
        const runner = vi.fn(async () => ({ status: "ok" as const }));
        const state = createCronRegressionState({
          storePath,
          nowMs: () => now,
          defaultAgentId: "main",
          runIsolatedAgentJob: runner,
        });
        let stopObservingCommits: (() => void) | undefined;
        let captured: { identity: object; receipt: CronRunReceiptHandle } | undefined;
        const settlements: string[] = [];
        const policy = entrypoint === "startup" ? "startup-settlement" : "scheduled-ineligible";
        const attemptedPolicies: string[] = [];
        const release = admissionMutation.releaseReservedCronRuns;
        const observed = vi
          .spyOn(admissionMutation, "releaseReservedCronRuns")
          .mockImplementation(async (params) => {
            attemptedPolicies.push(params.policy?.kind ?? "general");
            if (params.policy?.kind !== policy) {
              return release(params);
            }
            const owner = state.queuedRunReservationsByJobId.get(job.id);
            if (!captured && owner) {
              captured = { identity: owner.identity, receipt: { ...owner.runReceipt } };
              expect(isCronRunReceiptOwnerStale(captured.receipt, now)).toBe(false);
            }
            return release({
              ...params,
              onSettled(outcome) {
                settlements.push(outcome);
                params.onSettled(outcome);
              },
            });
          });
        try {
          await saveCronStore(storePath, { version: 1, jobs: [job] });
          const database = openOpenClawStateDatabase().db;
          let reservationObserved = false;
          stopObservingCommits = observeCronStoreCommits(storePath, () => {
            if (reservationObserved) {
              return;
            }
            const queued = database
              .prepare(
                "SELECT 1 FROM cron_jobs WHERE store_key = ? AND job_id = ? AND json_extract(state_json, '$.queuedAtMs') = ?",
              )
              .get(cronStoreKey(storePath), job.id, now);
            if (queued) {
              reservationObserved = true;
              if (entrypoint === "startup") {
                stop(state);
              } else {
                // Preserve the queued claim but make the real scheduled activation ineligible.
                database
                  .prepare(
                    "UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', ?) WHERE store_key = ? AND job_id = ?",
                  )
                  .run(futureAt, cronStoreKey(storePath), job.id);
              }
            }
          });
          const outcome = await (
            entrypoint === "startup" ? runMissedJobs(state) : onTimer(state)
          ).then(
            () => ({ kind: "reported" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          await fault.waitForExit();
          expect.soft(attemptedPolicies).toEqual([policy]);
          expect.soft(fault.attempts).toEqual(["cron.releaseReservations"]);
          expect(reservationObserved).toBe(true);
          expect(fault.wasHeld()).toBe(true);
          expect(settlements).toEqual(["unknown"]);
          if (outcome.kind !== "rejected") {
            throw new Error(
              `${entrypoint} reported success after losing its native cleanup settlement`,
            );
          }
          expect(hasSqliteWorkerOutcomeUnknown(outcome.error)).toBe(true);
          const original = expectDefined(captured, `${entrypoint} reservation before cleanup`);
          expect
            .soft(
              database
                .prepare(
                  "SELECT status, finished_at_ms FROM cron_run_receipts WHERE receipt_id = ?",
                )
                .get(original.receipt.receiptId),
            )
            .toEqual({ status: "running", finished_at_ms: null });
          const persisted = (await loadCronStore(storePath)).jobs.find((row) => row.id === job.id);
          expect.soft(persisted?.state).toMatchObject({
            queuedAtMs: now,
            nextRunAtMs: entrypoint === "startup" ? now : futureAt,
          });
          expect(persisted?.state.runningAtMs).toBeUndefined();
          expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
          expect(isCronRunReceiptOwnerStale(original.receipt, now)).toBe(true);
          expect(state.runAdmission.active).toBe(0);
          expect(runner).not.toHaveBeenCalled();
          expect(
            readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
              .entries,
          ).toEqual([]);
        } finally {
          stopObservingCommits?.();
          observed.mockRestore();
          await fault.close();
          if (captured) {
            admissionMutation.releaseReservationOwnership(state, [
              { jobId: job.id, reservationIdentity: captured.identity },
            ]);
          }
          stop(state);
          await state.op;
        }
      },
    );
  },
);

it.each(["manual", "startup"] as const)(
  "retains a committed %s cleanup failure without retrying its reservation",
  async (entrypoint) => {
    const { storePath } = opsRegressionFixtures.makeStorePath();
    const now = Date.now();
    const futureAt = now + 60_000;
    const job = createDueIsolatedJob({
      id: `lost-${entrypoint}-cleanup-reply`,
      nowMs: now,
      nextRunAtMs: entrypoint === "manual" ? futureAt : now,
    });
    job.state.lastError = "prior occurrence error";
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      defaultAgentId: "main",
      runIsolatedAgentJob: runner,
    });
    const database = openOpenClawStateDatabase().db;
    let receiptId: string | undefined;
    const stopObservingCommits = observeCronStoreCommits(storePath, () => {
      if (receiptId) {
        return;
      }
      const queued = database
        .prepare(
          "SELECT 1 FROM cron_jobs WHERE store_key = ? AND job_id = ? AND json_extract(state_json, '$.queuedAtMs') = ?",
        )
        .get(cronStoreKey(storePath), job.id, now);
      if (!queued) {
        return;
      }
      const receipt = database
        .prepare(
          "SELECT receipt_id FROM cron_run_receipts WHERE store_key = ? AND job_id = ? AND status = 'running'",
        )
        .get(cronStoreKey(storePath), job.id);
      if (typeof receipt?.receipt_id !== "string") {
        throw new Error("The committed reservation has no running receipt");
      }
      receiptId = receipt.receipt_id;
      if (entrypoint === "manual") {
        stop(state);
      } else {
        // Keep the real reservation but make its occurrence ineligible before startup activation.
        database
          .prepare(
            "UPDATE cron_jobs SET state_json = json_set(state_json, '$.nextRunAtMs', ?) WHERE store_key = ? AND job_id = ?",
          )
          .run(futureAt, cronStoreKey(storePath), job.id);
      }
    });
    const reply = loseFirstCronMutationReply("cron.releaseReservations");
    const pending = (
      entrypoint === "manual" ? run(state, job.id, "force") : runMissedJobs(state)
    ).then(
      () => ({ kind: "reported" }),
      (error: unknown) => ({ kind: "rejected", error }),
    );
    try {
      expect(await pending).toMatchObject({ kind: "rejected", error: expect.any(Error) });
      expect(receiptId).toEqual(expect.any(String));
      expect(reply.wasDropped()).toBe(true);
      await reply.waitForExit();
      expect(reply.attempts).toEqual(["cron.releaseReservations"]);
      expect(
        database
          .prepare("SELECT status, error_text FROM cron_run_receipts WHERE receipt_id = ?")
          .get(receiptId!),
      ).toEqual({
        status: "skipped",
        error_text:
          entrypoint === "manual"
            ? "cron manual reservation abandoned before completion"
            : "cron startup reservation abandoned before completion",
      });
      const persisted = (await loadCronStore(storePath)).jobs.find((row) => row.id === job.id);
      expect(persisted?.state).toMatchObject({
        nextRunAtMs: futureAt,
        lastError: "prior occurrence error",
      });
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(persisted?.state.runningReceiptId).toBeUndefined();
      expect(state.queuedRunReservationsByJobId.has(job.id)).toBe(false);
      expect(state.runAdmission.active).toBe(0);
      expect(runner).not.toHaveBeenCalled();
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries,
      ).toEqual([]);
    } finally {
      stopObservingCommits();
      await pending;
      await reply.close();
      stop(state);
      await state.op;
    }
  },
);

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

it.each([
  { phase: "planning", route: "default", boundary: "after commit" },
  { phase: "planning", route: "absence", boundary: "after commit" },
  { phase: "planning", route: "explicit agent", boundary: "after commit" },
  { phase: "planning", route: "session owner", boundary: "after commit" },
  { phase: "cleanup", route: "default", boundary: "after commit" },
  { phase: "planning", route: "default", boundary: "before commit" },
  { phase: "cleanup", route: "default", boundary: "before commit" },
] as const)(
  "guards startup $phase auto-disable routing when the default changes $boundary ($route)",
  async ({ phase, route, boundary }) => {
    const { storePath } = opsRegressionFixtures.makeStorePath();
    const now = Date.now();
    const job = createDueIsolatedJob({
      id: "startup-notice-route",
      nowMs: now,
      nextRunAtMs: now,
    });
    if (phase === "planning") {
      job.schedule = { kind: "cron", expr: "invalid" };
      job.state.scheduleErrorCount = 2;
    }
    if (route === "explicit agent") {
      job.agentId = "explicit-owner";
    } else if (route === "session owner") {
      job.sessionKey = "agent:session-owner:main";
    }
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    const originalStore = await loadCronStore(storePath);
    const database = openOpenClawStateDatabase().db;
    const readEnabled = () =>
      database
        .prepare("SELECT enabled FROM cron_jobs WHERE store_key = ? AND job_id = ?")
        .get(cronStoreKey(storePath), job.id)?.enabled;
    let currentDefault = route === "default" ? "original-agent" : undefined;
    let committed = false;
    let observedBeforeCommit = false;
    const order: string[] = [];
    const enqueueSessionEvent = vi.fn(() => {
      expect(readEnabled()).toBe(0);
      order.push("notify");
    });
    const warn = vi.fn();
    const runner = vi.fn(async () => ({ status: "ok" as const }));
    const resolveDefaultAgentId = vi.fn(() => {
      if (route === "explicit agent" || route === "session owner") {
        throw new Error("explicit notice owner must not consult the default");
      }
      return currentDefault;
    });
    const state = createCronRegressionState({
      storePath,
      nowMs: () => now,
      resolveDefaultAgentId,
      cronConfig: { skipMissedJobs: phase === "planning" },
      maxMissedJobsPerRestart: 0,
      // Exercise the actual startup-settlement auto-disable producer on Date overflow.
      missedJobStaggerMs: Number.MAX_SAFE_INTEGER,
      enqueueSessionEvent,
      runIsolatedAgentJob: runner,
    });
    state.deps.defaultAgentId = undefined;
    state.deps.log = { ...state.deps.log, warn };
    const stopObserving = observeCronStoreCommits(storePath, () => {
      if (!committed && readEnabled() === 0) {
        committed = true;
        order.push("commit");
        currentDefault = "replacement-agent";
      }
    });
    const stopObservingWrites =
      boundary === "before commit"
        ? observeCronJobWrites(job.id, () => {
            if (!observedBeforeCommit) {
              // The worker has changed its row, but the real host grant has not committed it.
              expect(readEnabled()).toBe(1);
              observedBeforeCommit = true;
              currentDefault = "replacement-agent";
            }
          })
        : undefined;
    try {
      const outcome = await runMissedJobs(state).then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
      const persistedStore = await loadCronStore(storePath);
      const persisted = persistedStore.jobs.find((entry) => entry.id === job.id);
      expect(runner).not.toHaveBeenCalled();
      expect(state.runAdmission.active).toBe(0);
      expect(state.queuedRunReservationsByJobId.size).toBe(0);
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries,
      ).toEqual([]);
      expect(
        database
          .prepare("SELECT receipt_id FROM cron_run_receipts WHERE store_key = ? AND job_id = ?")
          .all(cronStoreKey(storePath), job.id),
      ).toEqual([]);
      expect(state.startupCatchup).toBeUndefined();
      if (boundary === "before commit") {
        expect(observedBeforeCommit).toBe(true);
        expect.soft(outcome).toMatchObject({
          kind: "rejected",
          error: { message: "Cron notification default owner changed before commit" },
        });
        expect(persistedStore).toEqual(originalStore);
        expect(state.store?.jobs.find((entry) => entry.id === job.id)?.enabled).toBe(true);
        expect(committed).toBe(false);
        expect(order).toEqual([]);
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
        return;
      }
      expect(outcome).toEqual({ kind: "completed" });
      expect(committed).toBe(true);
      expect(persisted).toMatchObject({
        enabled: false,
        schedule: job.schedule,
        payload: job.payload,
        state: {
          autoDisabled: {
            reason: "schedule-errors",
            atMs: now,
            consecutiveErrors: phase === "planning" ? 3 : 1,
          },
        },
      });
      expect(persisted?.state.scheduleErrorCount).toBe(phase === "planning" ? 3 : undefined);
      expect(persisted?.state.nextRunAtMs).toBeUndefined();
      expect(persisted?.state.startupCatchupAtMs).toBeUndefined();
      expect(persisted?.state.queuedAtMs).toBeUndefined();
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(state.store?.jobs.find((entry) => entry.id === job.id)?.enabled).toBe(false);
      if (route === "absence") {
        expect(order).toEqual(["commit"]);
        expect(enqueueSessionEvent).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          { error: CRON_AGENT_SELECTION_REQUIRED_MESSAGE },
          "cron: post-persist notification failed",
        );
      } else {
        const agentId =
          route === "explicit agent"
            ? "explicit-owner"
            : route === "session owner"
              ? "session-owner"
              : "original-agent";
        expect(order).toEqual(["commit", "notify"]);
        expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
          expect.stringContaining("was auto-disabled"),
          expect.objectContaining({
            agentId,
            sessionKey: job.sessionKey,
            contextKey: `cron:${job.id}:auto-disabled`,
          }),
        );
        if (route !== "default") {
          expect(resolveDefaultAgentId).not.toHaveBeenCalled();
        }
      }
    } finally {
      stopObservingWrites?.();
      stopObserving();
      stop(state);
      await state.op;
    }
  },
);
