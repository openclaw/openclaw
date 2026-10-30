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
import { locked } from "./locked.js";
import { start, stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { enqueueRun, run, waitForManualRun } from "./ops-run.js";
import {
  createBlockedCronRun,
  createCronRunFixture,
  createHeldCronRunner,
} from "./ops.test-support.js";
import { waitForCronRunQueue } from "./run-queue.js";
import { onTimer, runMissedJobs } from "./timer.test-support.js";

const opsRegressionFixtures = setupCronRegressionFixtures({
  prefix: "cron-service-run-admission-cleanup-",
});

type RegressionParams = Parameters<typeof createCronRegressionState>[0];
function makeJob(id: string, nowMs: number, nextRunAtMs = nowMs) {
  return createDueIsolatedJob({ id, nowMs, nextRunAtMs });
}
function fixture(
  job: ReturnType<typeof makeJob>,
  overrides: Partial<Omit<RegressionParams, "storePath">> = {},
) {
  return createCronRunFixture(opsRegressionFixtures.makeStorePath().storePath, job, overrides);
}

type ActivationTrigger = "scheduled" | "startup";

async function activationFixture(trigger: ActivationTrigger, priorFailure = true) {
  const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
  const job = makeJob(`activation-${trigger}`, dueAt);
  if (priorFailure) {
    job.state.lastError = "prior failure";
  }
  const base = await fixture(job);
  const execute = () => (trigger === "scheduled" ? onTimer(base.state) : runMissedJobs(base.state));
  return { ...base, dueAt, job, execute };
}

describe("cron service run admission cleanup", () => {
  it("records an admitted execution error after its agent becomes unavailable", async () => {
    const startedAt = Date.parse("2026-02-06T10:05:01.750Z");
    const job = makeJob("manual-unavailable-error-is-not-authorization", startedAt);
    job.agentId = "main";
    const { started, release: releaseRun, runner } = createHeldCronRunner();
    let ownerAvailable = true;
    const { readJob, receipt, state } = await fixture(job, {
      isAgentAvailable: () => ownerAvailable,
      runIsolatedAgentJob: runner,
    });

    const activeRun = run(state, job.id, "force");
    await started;
    ownerAvailable = false;
    releaseRun.resolve({
      status: "error",
      error: "cron job agent is unavailable: main",
    });
    await expect(activeRun).resolves.toEqual({ ok: true, ran: true });

    const persisted = await readJob();
    expect(persisted?.state).toMatchObject({
      lastRunStatus: "error",
      lastError: "cron job agent is unavailable: main",
    });
    expect(persisted?.state.runningAtMs).toBeUndefined();
    expect(receipt()?.status).toBe("error");
  });

  it("rejects enqueue preflight effects after authority closes", async () => {
    const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
    const job = makeJob("revoked-preflight", dueAt);
    job.sessionTarget = "main";
    const onEvent = vi.fn();
    const { store, state, runIsolatedAgentJob } = await fixture(job, { onEvent });
    const before = await loadCronStore(store.storePath);
    const lockEntered = createDeferred();
    const releaseLock = createDeferred();
    const blocker = locked(state, async () => {
      lockEntered.resolve();
      await releaseLock.promise;
    });
    await lockEntered.promise;
    let authorityActive = true;
    const operation = enqueueRun(state, job.id, "force", {
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
  });

  it.each([false, true])(
    "retains the disconnected queued caller until settlement (revoked: %s)",
    async (revoked) => {
      vi.useRealTimers();
      const store = opsRegressionFixtures.makeStorePath();
      const dueAt = Date.parse("2026-02-06T10:05:03.000Z");
      const job = makeJob("revoked-queued-run", dueAt);
      const context = {};
      const connection = new AbortController();
      const caller = captureGatewayDeviceRevocation(
        context,
        { deviceId: "queued-device", role: "operator" },
        () => true,
        connection.signal,
      );
      const {
        state,
        runIsolatedAgentJob,
        activeRun: blocker,
        releaseActive: releaseBlocker,
        readJob,
      } = await createBlockedCronRun(store.storePath, job);

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
        releaseBlocker.resolve({ status: "ok" });
        await blocker;
        if (!ack.ok || !("runId" in ack)) {
          throw new Error("Expected an acknowledged queued run");
        }
        expect(await waitForManualRun(state, ack.runId, 60_000)).toBe(true);
        const targetCalls = runIsolatedAgentJob.mock.calls.filter(
          ([{ job: current }]) => current.id === job.id,
        );
        expect(targetCalls).toHaveLength(revoked ? 0 : 1);
        expect((await readJob())?.state.queuedAtMs).toBeUndefined();
        expect(caller.isCurrent()).toBe(false);
      } finally {
        caller.release();
        releaseBlocker.resolve({ status: "ok" });
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
      const job = makeJob(`manual-${mode}-${evaluation}-preserves-edited-schedule`, startedAt);
      job.schedule = { kind: "every", everyMs: 60_000, anchorMs: startedAt };
      await saveCronStore(store.storePath, { version: 1, jobs: [job] });

      const { started, release: releaseRun, runner } = createHeldCronRunner();
      const state = createCronRegressionState({
        storePath: store.storePath,
        nowMs: () => startedAt,
        runIsolatedAgentJob: runner,
      });

      const activeRun = run(state, job.id, mode);
      await started;
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
    const { readJob, dueAt, job, state, runIsolatedAgentJob, execute } =
      await activationFixture("scheduled");
    const markerTransitions: Array<"running" | "idle"> = [];
    const stopObserving = observeCronJobCommits(job.id, ({ queuedAtMs, runningAtMs }) => {
      if (markerTransitions.length === 0 && runningAtMs === dueAt) {
        markerTransitions.push("running");
        stop(state);
      } else if (markerTransitions.length === 1 && !queuedAtMs && !runningAtMs) {
        markerTransitions.push("idle");
      }
    });
    try {
      await execute();
    } finally {
      stopObserving();
    }
    expect(runIsolatedAgentJob).not.toHaveBeenCalled();
    expect(markerTransitions).toEqual(["running", "idle"]);
    const persisted = await readJob();
    expect(persisted?.state.runningAtMs).toBeUndefined();
    expect(persisted?.state.lastError).toBe("prior failure");
  });

  it.each(["activation", "dispatch"] as const)(
    "rejects a manual run when the scheduler restarts during %s",
    async (phase) => {
      const activation = phase === "activation";
      const dueAt = Date.parse(
        activation ? "2026-02-06T10:05:03.125Z" : "2026-02-06T10:05:03.150Z",
      );
      const job = makeJob(`manual-${phase}-retired-by-restart`, dueAt, dueAt + 3_600_000);
      if (activation) {
        job.state.lastError = "prior failure";
      }
      let restart: Promise<void> | undefined;
      const { clock, state, runIsolatedAgentJob, readJob, receipt } = await fixture(job, {
        onEvent: (event) => {
          if (!activation && event.action === "started" && !restart) {
            stop(state);
            restart = start(state);
          }
        },
      });
      const stopObserving = observeCronJobCommits(job.id, ({ queuedAtMs, runningAtMs }) => {
        if (!activation) {
          return;
        }
        if (queuedAtMs === dueAt) {
          clock.now = dueAt + 1;
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
        if (activation) {
          const persisted = await readJob();
          expect(persisted?.state.runningAtMs).toBeUndefined();
          expect(persisted?.state.lastError).toBe("prior failure");
        }
        expect(receipt()?.status).toBe("skipped");
      } finally {
        stopObserving();
        await restart;
        stop(state);
      }
    },
  );

  it.each([
    { trigger: "startup", failure: "activation" },
    { trigger: "scheduled", failure: "cleanup-terminal" },
  ] as const)(
    "releases $trigger ownership after $failure persistence fails",
    async ({ trigger, failure }) => {
      const terminal = failure === "cleanup-terminal";
      const { readJob, dueAt, job, state, runIsolatedAgentJob, execute } = await activationFixture(
        trigger,
        !terminal,
      );
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
      const stopObserving = observeCronJobCommits(job.id, ({ runningAtMs }) => {
        if (runningAtMs === dueAt && terminal) {
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
        // The stop observer runs before launch registration; join the later cleanup too.
        await state.schedulerDrain;
        await waitForCronRunQueue(state);
      } finally {
        stopObserving();
        database.exec("DROP TRIGGER fail_cron_activation_or_cleanup");
      }
      expect(runIsolatedAgentJob).not.toHaveBeenCalled();
      const persisted = await readJob();
      if (terminal) {
        expect(persisted?.state.runningAtMs).toBe(dueAt);
      } else {
        expect(persisted?.state.runningAtMs).toBeUndefined();
        expect(persisted?.state.lastError).toBe("prior failure");
      }
    },
  );
});
