import { expect, it } from "vitest";
import {
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run } from "./ops-run.js";
import { createCronRunFixture, createHeldCronRunner } from "./ops.test-support.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-disable-running-" });

it("cancels a forced paused job on explicit disable, but not a display edit", async () => {
  const nowMs = Date.parse("2026-02-06T10:05:00.000Z");
  const job = createDueIsolatedJob({
    id: "paused-force-disable",
    nowMs,
    nextRunAtMs: nowMs + 3_600_000,
  });
  job.enabled = false;
  const held = createHeldCronRunner();
  const { state } = await createCronRunFixture(fixtures.makeStorePath().storePath, job, {
    runIsolatedAgentJob: held.runner,
  });
  const running = run(state, job.id, "force");
  try {
    await held.started;
    const signal = held.runner.mock.calls[0]?.[0].abortSignal;
    expect(signal).toBeDefined();
    await update(state, job.id, { description: "Still paused, manually running" });
    expect(signal?.aborted).toBe(false);

    await update(state, job.id, { enabled: false });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("Cron job disabled by operator.");
  } finally {
    held.release.resolve({ status: "ok" });
    await running;
    stop(state);
  }
});
