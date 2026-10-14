import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../agent-id.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { inspectActiveCronRunReceipt } from "../store/run-receipt-store.test-support.js";
import { stop } from "./ops-lifecycle.js";
import { list } from "./ops-read.js";
import { run } from "./ops-run.js";

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
