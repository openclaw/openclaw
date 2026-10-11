import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../../test/helpers/cron/runtime-mutation.js";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { start, stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { prepareManualRun } from "./ops-run-preparation.js";
import { run } from "./ops-run.js";
import { cleanupQueuedCronRunReservations } from "./run-admission.js";
import * as runtimeMutation from "./runtime-mutation.js";
import { onTimer } from "./timer.test-support.js";

it.each(["manual", "timer", "startup"] as const)(
  "stops a committed %s reservation before execution when the scheduler restarts",
  async (entrypoint) => {
    await withOpenClawTestState({ label: "cron-reservation-lifecycle" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({
        id: "pending-reservation",
        nowMs: now - 2_000,
        nextRunAtMs: now - 1_000,
      });
      job.payload = { kind: "command", argv: ["echo", "synthetic"] };
      const deferred = createDueIsolatedJob({
        id: "deferred-agent",
        nowMs: now - 2_000,
        nextRunAtMs: now - 500,
      });
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        storePath,
        nowMs: () => now,
        defaultAgentId: "main",
        isAgentAvailable: () => true,
        runCommandJob: runner,
        runIsolatedAgentJob: runner,
      });
      await saveCronStore(storePath, {
        version: 1,
        jobs: entrypoint === "startup" ? [job, deferred] : [job],
      });
      await list(state);
      let observed = false;
      let restarted: Promise<void> | undefined;
      const stopObserving = observeCronJobCommits(job.id, (committed) => {
        if (!observed && committed.queuedAtMs !== undefined) {
          observed = true;
          stop(state);
          state.deps.cronEnabled = false;
          restarted = start(state);
        }
      });
      try {
        const result = await (entrypoint === "manual"
          ? prepareManualRun(state, job.id, "force")
          : entrypoint === "timer"
            ? onTimer(state)
            : start(state));
        await restarted;
        expect(observed, "the real entrypoint must commit its reservation").toBe(true);
        expect(state.stopped).toBe(false);
        if (entrypoint === "manual") {
          expect(result).toEqual({ ok: true, ran: false, reason: "stopped" });
        }
        expect(runner).not.toHaveBeenCalled();
        const persisted = await loadCronStore(storePath);
        expect(
          persisted.jobs.find((entry) => entry.id === job.id)?.state.queuedAtMs,
        ).toBeUndefined();
        if (entrypoint === "startup") {
          expect(persisted.jobs.find((entry) => entry.id === deferred.id)?.state).toEqual(
            deferred.state,
          );
        }
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        expect(state.runAdmission.active).toBe(0);
        expect(state.runAdmission.waiters).toEqual([]);
        expect(state.activeTimerTicks).toBe(0);
      } finally {
        await restarted;
        stopObserving();
        stop(state);
        await state.op;
      }
    });
  },
);

it.each(["reader", "retired source"] as const)(
  "keeps the prior owner visible when an update encounters a %s observation failure",
  async (failure) => {
    await withOpenClawTestState({ label: "cron-owner-observation-failure" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "owner-edit", nowMs: now, nextRunAtMs: now + 60_000 });
      job.agentId = "alpha";
      job.declarationKey = "agent:alpha:owner-edit";
      const onEvent = vi.fn();
      const state = createCronRegressionState({
        storePath,
        cronEnabled: false,
        nowMs: () => now,
        defaultAgentId: "alpha",
        isAgentAvailable: () => true,
        runIsolatedAgentJob: async () => ({ status: "ok" }),
        onEvent,
      });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      await list(state);
      onEvent.mockClear();
      const execute = stateRead.executeExistingOpenClawStateRead;
      const reader = vi
        .spyOn(stateRead, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await execute(...args);
          if (args[1].type === "cron.observeRunRecovery") {
            if (failure === "reader") {
              throw new Error("receipt observation refused");
            }
            await closeOpenClawStateDatabaseAsync();
          }
          return result;
        });
      try {
        const mutation = update(state, job.id, { agentId: "beta" });
        if (failure === "reader") {
          await expect(mutation).rejects.toThrow("receipt observation refused");
        } else {
          await expect(mutation).rejects.toMatchObject({
            code: "STATE_DATABASE_READ_ADMISSION_INVALIDATED",
          });
        }
        expect(state.store?.jobs.find((entry) => entry.id === job.id)?.agentId).toBe("alpha");
        expect(
          (await list(state, { includeDisabled: true })).find((entry) => entry.id === job.id)
            ?.agentId,
        ).toBe("alpha");
        expect((await loadCronStore(storePath)).jobs[0]?.agentId).toBe("alpha");
        expect(onEvent).not.toHaveBeenCalled();
      } finally {
        reader.mockRestore();
        stop(state);
        await state.op;
      }
    });
  },
);

it("keeps a sibling owner edit behind a pending manual reservation on the same store", async () => {
  await withOpenClawTestState({ label: "cron-receipt-observation-fifo" }, async (fixture) => {
    const now = Date.now();
    const storePath = fixture.statePath("cron", "jobs.json");
    const job = createDueIsolatedJob({ id: "ordered-reservation", nowMs: now, nextRunAtMs: now });
    job.agentId = "alpha";
    const deps = {
      storePath,
      nowMs: () => now,
      defaultAgentId: "alpha",
      isAgentAvailable: () => true,
      runIsolatedAgentJob: async () => ({ status: "ok" as const }),
    };
    const owner = createCronRegressionState(deps);
    const editor = createCronRegressionState(deps);
    await saveCronStore(storePath, { version: 1, jobs: [job] });
    await list(owner);
    await list(editor);
    const entered = createDeferred();
    const release = createDeferred();
    const execute = runtimeMutation.runCronRuntimeMutation;
    let observed = false;
    const reader = vi
      .spyOn(runtimeMutation, "runCronRuntimeMutation")
      .mockImplementation(async (params) => {
        if (params.type === "cron.reserveRuns" && !observed) {
          observed = true;
          entered.resolve();
          await release.promise;
        }
        return execute(params);
      });
    const pending = prepareManualRun(owner, job.id, "force");
    void pending.then(
      () => entered.resolve(),
      () => entered.resolve(),
    );
    let edit: Promise<unknown> | undefined;
    let result: Awaited<typeof pending> | undefined;
    try {
      await entered.promise;
      expect(observed).toBe(true);
      let settled = false;
      edit = update(editor, job.id, { agentId: "beta" });
      void edit.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await nextTurn();
      expect(settled).toBe(false);
      release.resolve();
      result = await pending;
      expect(result).toMatchObject({ ok: true, ran: true });
      await expect(edit).rejects.toThrow("already running");
      expect((await loadCronStore(storePath)).jobs[0]?.agentId).toBe("alpha");
      expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })?.agentId).toBe("alpha");
    } finally {
      release.resolve();
      result ??= await pending.catch(() => undefined);
      await edit?.catch(() => undefined);
      reader.mockRestore();
      if (result?.ok && result.ran) {
        await cleanupQueuedCronRunReservations({
          state: owner,
          reservations: [{ jobId: job.id, reservationIdentity: result.reservationIdentity }],
        });
      }
      stop(owner);
      stop(editor);
      await Promise.all([owner.op, editor.op]);
    }
  });
});

it.each(["ambient", "explicit"] as const)(
  "rechecks the %s job owner when the current default disappears before dispatch",
  async (owner) => {
    await withOpenClawTestState({ label: "cron-current-default-removal" }, async (fixture) => {
      const now = Date.now();
      const storePath = fixture.statePath("cron", "jobs.json");
      const job = createDueIsolatedJob({ id: "current-default", nowMs: now, nextRunAtMs: now });
      job.payload = { kind: "command", argv: ["echo", "synthetic"] };
      if (owner === "explicit") {
        job.agentId = "alpha";
      }
      let currentDefault: string | undefined = "alpha";
      const runner = vi.fn(async () => ({ status: "ok" as const }));
      const state = createCronRegressionState({
        storePath,
        nowMs: () => now,
        defaultAgentId: "alpha",
        resolveDefaultAgentId: () => currentDefault,
        isAgentAvailable: () => true,
        runCommandJob: runner,
        runIsolatedAgentJob: runner,
      });
      await saveCronStore(storePath, { version: 1, jobs: [job] });
      await list(state);
      let removed = false;
      const execute = runtimeMutation.runCronRuntimeMutation;
      const mutation = vi
        .spyOn(runtimeMutation, "runCronRuntimeMutation")
        .mockImplementation(async (params) => {
          if (params.type === "cron.reserveRuns" && !removed) {
            removed = true;
            currentDefault = undefined;
          }
          return execute(params);
        });
      try {
        const pending = run(state, job.id, "force");
        if (owner === "explicit") {
          await expect(pending).resolves.toMatchObject({ ok: true, ran: true });
          expect(runner).toHaveBeenCalledOnce();
        } else {
          await expect(pending).rejects.toThrow(CRON_AGENT_SELECTION_REQUIRED_MESSAGE);
          expect(runner).not.toHaveBeenCalled();
          expect((await loadCronStore(storePath)).jobs[0]?.state).toEqual(job.state);
        }
        expect(removed).toBe(true);
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
        expect(state.queuedRunReservationsByJobId.size).toBe(0);
        expect(state.runAdmission.active).toBe(0);
      } finally {
        mutation.mockRestore();
        stop(state);
        await state.op;
      }
    });
  },
);
