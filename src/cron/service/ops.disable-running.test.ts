import { expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  createDueIsolatedJob,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { saveCronStore } from "../store.js";
import { stop } from "./ops-lifecycle.js";
import { update } from "./ops-mutations.js";
import { run } from "./ops-run.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-disable-running-" });

it("cancels a forced paused job on explicit disable, but not a display edit", async () => {
  const nowMs = Date.parse("2026-02-06T10:05:00.000Z");
  const job = createDueIsolatedJob({
    id: "paused-force-disable",
    nowMs,
    nextRunAtMs: nowMs + 3_600_000,
  });
  job.enabled = false;
  const started = createDeferred();
  type Runner = Parameters<typeof createCronRegressionState>[0]["runIsolatedAgentJob"];
  const release = createDeferred<Awaited<ReturnType<Runner>>>();
  const runner = vi.fn<Runner>(async () => {
    started.resolve();
    return await release.promise;
  });
  const { storePath } = fixtures.makeStorePath();
  await saveCronStore(storePath, { version: 1, jobs: [job] });
  const state = createCronRegressionState({
    storePath,
    nowMs: () => nowMs,
    runIsolatedAgentJob: runner,
  });
  const running = run(state, job.id, "force");
  try {
    await started.promise;
    const signal = runner.mock.calls[0]?.[0].abortSignal;
    expect(signal).toBeDefined();
    await update(state, job.id, { description: "Still paused, manually running" });
    expect(signal?.aborted).toBe(false);

    await update(state, job.id, { enabled: false });
    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toBe("Cron job disabled by operator.");
  } finally {
    release.resolve({ status: "ok" });
    await running;
    stop(state);
  }
});
