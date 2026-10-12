import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";

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
      currentDefault = undefined;
      try {
        const pending = run(state, job.id, "force");
        if (owner === "explicit") {
          await expect(pending).resolves.toMatchObject({ ok: true, ran: true });
          expect(runner).toHaveBeenCalledOnce();
        } else {
          await expect(pending).resolves.toEqual({ ok: true, ran: false, reason: "ownerless" });
          expect(runner).not.toHaveBeenCalled();
          expect((await loadCronStore(storePath)).jobs[0]?.state).toMatchObject({
            lastRunStatus: "skipped",
            lastError: CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
          });
        }
        expect(inspectActiveCronRunReceipt({ storePath, jobId: job.id })).toBeUndefined();
      } finally {
        stop(state);
        await state.op;
      }
    });
  },
);
