import { expect, it } from "vitest";
import {
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { retireActiveCronTaskRunTracking } from "./active-run-cancellation.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { createCronRunFixture, createHeldCronRunner } from "./ops.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-disable-running-" });

it.each([
  { enabled: false, patch: { enabled: false }, reason: "Cron job disabled by operator." },
  { enabled: false, patch: { ownerProfileId: "bob" }, reason: "Cron job ownership transferred." },
  { enabled: true, patch: { ownerProfileId: "bob" }, reason: "Cron job ownership transferred." },
])(
  "cancels an active job on $patch (enabled=$enabled), but not a display edit",
  async ({ enabled, patch, reason }) => {
    const nowMs = Date.parse("2026-02-06T10:05:00.000Z");
    const job = createDueIsolatedJob({
      id: "paused-force-disable",
      nowMs,
      nextRunAtMs: nowMs + 3_600_000,
    });
    job.enabled = enabled;
    job.ownerProfileId = "alice";
    const held = createHeldCronRunner();
    const { state, readJob } = await createCronRunFixture(fixtures.makeStorePath().storePath, job, {
      runIsolatedAgentJob: held.runner,
    });
    const running = run(state, job.id, "force");
    try {
      await held.started;
      const signal = held.runner.mock.calls[0]?.[0].abortSignal;
      expect(signal).toBeDefined();
      await update(state, job.id, { description: "Manually running", ownerProfileId: "alice" });
      expect(signal?.aborted).toBe(false);

      // Teardown can retire the registry while this occurrence still owns its marker.
      retireActiveCronTaskRunTracking();
      await update(state, job.id, patch);
      expect(signal?.aborted).toBe(true);
      expect(signal?.reason).toBe(reason);
      await running;
      expect((await readJob())?.state.runningAtMs).toBeUndefined();
      held.release.resolve({ status: "ok" });
      if ("enabled" in patch) {
        await expect(run(state, job.id, "force")).resolves.toMatchObject({ ran: true });
      }
    } finally {
      held.release.resolve({ status: "ok" });
      await running;
      stop(state);
    }
  },
);
