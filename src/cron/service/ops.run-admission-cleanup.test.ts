// Worker-queue cleanup preserves caller authority and active-run outcomes.
import { describe, expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../gateway/device-revocation.js";
import { resolveCronMutationCommitGuard } from "../../gateway/server-methods/cron-caller-scope.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { createCronMutationCompletion } from "../mutation-completion.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { locked } from "./locked.js";
import { start, stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { enqueueRun, run, waitForManualRun } from "./ops-run.js";
import { runMissedJobs } from "./timer.js";
import { onTimer } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-cleanup-",
});

type ActivationTrigger = "manual" | "scheduled" | "startup";

async function activationFixture(trigger: ActivationTrigger, priorFailure = true) {
  const store = opsRegressionFixtures.makeStorePath();
  const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
  const clock = { now: dueAt };
  const job = createDueIsolatedJob({
    id: `activation-${trigger}`,
    nowMs: dueAt,
    nextRunAtMs: trigger === "manual" ? dueAt + 3_600_000 : dueAt,
  });
  if (priorFailure) {
    job.state.lastError = "prior failure";
  }
  await saveCronStore(store.storePath, { version: 1, jobs: [job] });
  const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
  const state = createCronRegressionState({
    storePath: store.storePath,
    nowMs: () => clock.now,
    runIsolatedAgentJob,
  });
  const execute = () =>
    trigger === "manual"
      ? run(state, job.id, "force")
      : trigger === "scheduled"
        ? onTimer(state)
        : runMissedJobs(state);
  return { store, dueAt, clock, job, state, runIsolatedAgentJob, execute };
}

describe("cron service run admission cleanup", () => {
  it("does not trust an unavailable-agent execution error as a settlement guard", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const startedAt = Date.parse("2026-02-06T10:05:01.750Z");
    const job = createDueIsolatedJob({
      id: "manual-unavailable-error-is-not-authorization",
      nowMs: startedAt,
      nextRunAtMs: startedAt,
    });
    job.agentId = "main";
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    const runnerStarted = createDeferred();
    const releaseRun = createDeferred<{ status: "error"; error: string }>();
    let ownerAvailable = true;
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => startedAt,
      isAgentAvailable: () => ownerAvailable,
      runIsolatedAgentJob: vi.fn(async () => {
        runnerStarted.resolve();
        return await releaseRun.promise;
      }),
    });

    const activeRun = run(state, job.id, "force");
    await runnerStarted.promise;
    ownerAvailable = false;
    releaseRun.resolve({
      status: "error",
      error: "cron job agent is unavailable: main",
    });
    await expect(activeRun).resolves.toEqual({ ok: true, ran: true });

    const persisted = (await loadCronStore(store.storePath)).jobs[0];
    expect(persisted?.state.lastRunStatus).toBeUndefined();
    expect(persisted?.state.runningAtMs).toBeUndefined();
    const receipt = openOpenClawStateDatabase()
      .db.prepare(
        "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
      )
      .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
    expect(receipt?.status).toBe("superseded");
  });

  it.each(["enqueue", "run"] as const)(
    "rejects %s preflight effects after authority closes",
    async (entry) => {
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const job = createDueIsolatedJob({
        id: "revoked-preflight",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      job.sessionTarget = "main";
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });
      const before = await loadCronStore(store.storePath);
      const onEvent = vi.fn();
      const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => dueAt,
        runIsolatedAgentJob,
        onEvent,
      });
      const lockEntered = createDeferred();
      const releaseLock = createDeferred();
      const blocker = locked(state, async () => {
        lockEntered.resolve();
        await releaseLock.promise;
      });
      await lockEntered.promise;
      let authorityActive = true;
      const operation = (entry === "enqueue" ? enqueueRun : run)(state, job.id, "force", {
        commitGuard: () => {
          if (!authorityActive) {
            throw new TypeError("authority closed");
          }
        },
      });
      authorityActive = false;
      releaseLock.resolve();
      await blocker;
      try {
        await expect.soft(operation).rejects.toThrow("authority closed");
        expect.soft(await loadCronStore(store.storePath)).toEqual(before);
        expect.soft(onEvent).not.toHaveBeenCalled();
        expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      } finally {
        stop(state);
      }
    },
  );

  it.each([false, true])(
    "retains the disconnected queued caller until settlement (revoked: %s)",
    async (revoked) => {
      vi.useRealTimers();
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const job = createDueIsolatedJob({
        id: "revoked-queued-run",
        nowMs: dueAt,
        nextRunAtMs: dueAt,
      });
      const blockerJobs = Array.from({ length: 8 }, (_, index) =>
        createDueIsolatedJob({
          id: `revoked-blocker-${index}`,
          nowMs: dueAt,
          nextRunAtMs: dueAt + 3_600_000,
        }),
      );
      await saveCronStore(store.storePath, { version: 1, jobs: [...blockerJobs, job] });
      const blockersStarted = createDeferred();
      const releaseBlocker = createDeferred();
      let started = 0;
      const context = {};
      const connection = new AbortController();
      const caller = captureGatewayDeviceRevocation(
        context,
        { deviceId: "queued-device", role: "operator" },
        () => true,
        connection.signal,
      );
      const runIsolatedAgentJob = vi.fn(async ({ job: current }: { job: typeof job }) => {
        if (current.id.startsWith("revoked-blocker-")) {
          if (++started === blockerJobs.length) {
            blockersStarted.resolve();
          }
          await releaseBlocker.promise;
        }
        return { status: "ok" as const };
      });
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => dueAt,
        runIsolatedAgentJob,
      });

      const blocker = Promise.all(blockerJobs.map((entry) => run(state, entry.id, "force")));
      await blockersStarted.promise;

      try {
        const commitGuard = resolveCronMutationCommitGuard(
          null,
          context as GatewayRequestContext,
          undefined,
          { hasCurrentClientAuthority: caller.isCurrent },
        );
        const completion = createCronMutationCompletion("cron.run");
        if (!completion) {
          throw new Error("Expected Cron completion owner");
        }
        const ack = await completion.run(() => enqueueRun(state, job.id, "force", { commitGuard }));
        expect(ack).toMatchObject({ ok: true, enqueued: true, runId: expect.any(String) });
        expect(completion.isCommitted()).toBe(true);
        caller.release();
        connection.abort();
        expect(caller.isCurrent()).toBe(true);
        if (revoked) {
          invalidateGatewayDeviceRevocation(context, "queued-device", "operator");
        }
        releaseBlocker.resolve();
        await blocker;
        if (!ack.ok || !("runId" in ack)) {
          throw new Error("Expected an acknowledged queued run");
        }
        expect(await waitForManualRun(state, ack.runId, 60_000)).toBe(true);
        const targetCalls = runIsolatedAgentJob.mock.calls.filter(
          ([{ job: current }]) => current.id === job.id,
        );
        expect(targetCalls).toHaveLength(revoked ? 0 : 1);
        expect(
          (await loadCronStore(store.storePath)).jobs.find((entry) => entry.id === job.id)?.state
            .queuedAtMs,
        ).toBeUndefined();
        expect(caller.isCurrent()).toBe(false);
      } finally {
        caller.release();
        releaseBlocker.resolve();
        await blocker;
        stop(state);
      }
    },
  );

  it.each([
    { mode: "force" as const, evaluation: "completed" as const },
    { mode: "due" as const, evaluation: "quiet" as const },
  ])(
    "preserves an operator-edited schedule after an active $mode $evaluation manual run",
    async ({ mode, evaluation }) => {
      const store = opsRegressionFixtures.makeStorePath();
      const startedAt = Date.parse("2026-02-06T10:05:02.000Z");
      const job = createDueIsolatedJob({
        id: `manual-${mode}-${evaluation}-preserves-edited-schedule`,
        nowMs: startedAt,
        nextRunAtMs: startedAt,
      });
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const runnerStarted = createDeferred();
      const releaseRun = createDeferred<{
        status: "ok";
        summary: string;
        triggerEval?: { fired: false; stateChanged: false };
      }>();
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => startedAt,
        runIsolatedAgentJob: vi.fn(async () => {
          runnerStarted.resolve();
          return await releaseRun.promise;
        }),
      });

      const activeRun = run(state, job.id, mode);
      await runnerStarted.promise;
      const editedJob = await update(state, job.id, {
        schedule: { kind: "every", everyMs: 3_600_000, anchorMs: startedAt },
      });
      const editedNextRunAtMs = editedJob.state.nextRunAtMs;
      expect(editedNextRunAtMs).toBe(startedAt + 3_600_000);

      releaseRun.resolve({
        status: "ok",
        summary: "manual run completed",
        ...(evaluation === "quiet" ? { triggerEval: { fired: false, stateChanged: false } } : {}),
      });
      await expect(activeRun).resolves.toMatchObject({ ok: true, ran: true });

      const persistedJob = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persistedJob?.schedule).toEqual(editedJob.schedule);
      expect(persistedJob?.state.nextRunAtMs).toBe(editedNextRunAtMs);
      expect(persistedJob?.state.forcePreservedNextRunAtMs).toBeUndefined();
    },
  );

  it("does not start a scheduled run when stop wins the activation write", async () => {
    const { store, dueAt, clock, job, state, runIsolatedAgentJob, execute } =
      await activationFixture("scheduled");
    let reservationPersisted = false;
    const markerTransitions: Array<"queued" | "running" | "idle"> = [];
    const stopObserving = observeCronJobCommits(job.id, ({ queuedAtMs, runningAtMs }) => {
      if (!reservationPersisted && queuedAtMs === dueAt) {
        reservationPersisted = true;
        markerTransitions.push("queued");
        clock.now = dueAt + 1;
      } else if (reservationPersisted && runningAtMs === dueAt + 1) {
        markerTransitions.push("running");
        stop(state);
      } else if (markerTransitions.length === 2 && !queuedAtMs && !runningAtMs) {
        markerTransitions.push("idle");
      }
    });
    try {
      await execute();
    } finally {
      stopObserving();
    }
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(markerTransitions).toEqual(["queued", "running", "idle"]);
    const persisted = (await loadCronStore(store.storePath)).jobs.find(
      (entry) => entry.id === job.id,
    );
    expect(persisted?.state.runningAtMs).toBeUndefined();
    expect(persisted?.state.lastError).toBe("prior failure");
  });

  it("does not revive a pre-stop manual activation when the scheduler immediately restarts", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.125Z");
    const job = createDueIsolatedJob({
      id: "manual-activation-retired-by-restart",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    job.state.lastError = "prior failure";
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let now = dueAt;
    let restart: Promise<void> | undefined;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => now,
      runIsolatedAgentJob,
    });
    const stopObserving = observeCronJobCommits(job.id, ({ queuedAtMs, runningAtMs }) => {
      if (queuedAtMs === dueAt) {
        now = dueAt + 1;
      } else if (runningAtMs === dueAt + 1 && !restart) {
        stop(state);
        restart = start(state);
      }
    });

    try {
      await expect(run(state, job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "stopped",
      });
      await restart;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      expect(persisted?.state.runningAtMs).toBeUndefined();
      expect(persisted?.state.lastError).toBe("prior failure");
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
    } finally {
      stopObserving();
      await restart;
      stop(state);
    }
  });

  it("rejects an activated manual run when its scheduler restarts before payload dispatch", async () => {
    const store = opsRegressionFixtures.makeStorePath();
    const dueAt = Date.parse("2026-02-06T10:05:03.150Z");
    const job = createDueIsolatedJob({
      id: "manual-dispatch-retired-by-restart",
      nowMs: dueAt,
      nextRunAtMs: dueAt + 3_600_000,
    });
    await saveCronStore(store.storePath, { version: 1, jobs: [job] });

    let restart: Promise<void> | undefined;
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const }));
    const state = createCronRegressionState({
      storePath: store.storePath,
      nowMs: () => dueAt,
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.action === "started" && !restart) {
          stop(state);
          restart = start(state);
        }
      },
    });

    try {
      await expect(run(state, job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "stopped",
      });
      await restart;

      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const receipt = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(store.storePath), job.id) as { status: string } | undefined;
      expect(receipt?.status).toBe("skipped");
    } finally {
      await restart;
      stop(state);
    }
  });

  it.each([
    { trigger: "startup", failure: "activation" },
    { trigger: "manual", failure: "cleanup-terminal" },
    { trigger: "scheduled", failure: "cleanup-terminal" },
  ] as const)(
    "releases $trigger ownership after $failure persistence fails",
    async ({ trigger, failure }) => {
      const terminal = failure === "cleanup-terminal";
      const { store, dueAt, clock, job, state, runIsolatedAgentJob, execute } =
        await activationFixture(trigger, !terminal);
      let reservationPersisted = false;
      let activationPersisted = false;
      let failureInjected = false;
      const errorText = terminal ? "terminal cleanup persist failed" : "activation persist failed";
      const database = openOpenClawStateDatabase().db;
      database.exec(`
        CREATE TRIGGER fail_cron_activation_or_cleanup
        BEFORE UPDATE OF state_json ON cron_jobs
        WHEN NEW.job_id = '${job.id}' AND ${
          terminal
            ? "json_extract(OLD.state_json, '$.runningAtMs') IS NOT NULL AND json_extract(NEW.state_json, '$.runningAtMs') IS NULL"
            : "json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL"
        }
        BEGIN
          SELECT RAISE(ABORT, '${errorText}');
        END;
      `);
      const stopObserving = observeCronJobCommits(job.id, ({ queuedAtMs, runningAtMs }) => {
        if (!reservationPersisted && queuedAtMs === dueAt) {
          reservationPersisted = true;
          clock.now = dueAt + 1;
        } else if (reservationPersisted && runningAtMs === dueAt + 1 && terminal) {
          activationPersisted = true;
          stop(state);
        }
      });
      try {
        await expect(
          execute().catch((error: unknown) => {
            failureInjected = true;
            throw error;
          }),
        ).rejects.toThrow(errorText);
        expect(failureInjected).toBe(true);
        expect(activationPersisted).toBe(terminal);
        // Keep the storage fault active until every stopped launch cleanup has settled.
        await state.schedulerDrain;
      } finally {
        stopObserving();
        database.exec("DROP TRIGGER fail_cron_activation_or_cleanup");
      }
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const persisted = (await loadCronStore(store.storePath)).jobs.find(
        (entry) => entry.id === job.id,
      );
      if (terminal) {
        expect(persisted?.state.runningAtMs).toBe(dueAt + 1);
      } else {
        expect(persisted?.state.runningAtMs).toBeUndefined();
        expect(persisted?.state.lastError).toBe("prior failure");
      }
    },
  );
});
