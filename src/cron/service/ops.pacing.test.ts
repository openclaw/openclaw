import { beforeEach, expect, it, vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import { add, update } from "./ops-mutations.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pacing-ops" });
const NOW = Date.parse("2026-07-18T12:00:00.000Z");

let state: ReturnType<typeof createCronRegressionState>;
beforeEach(async () => {
  const { storePath } = await makeStorePath();
  state = createCronRegressionState({
    storePath,
    log: logger,
    nowMs: () => NOW,
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
});

it.each([NOW, undefined])(
  "preserves a pending paced slot and schedule on an unrelated edit (anchor=%s)",
  async (anchorMs) => {
    const pendingSlot = NOW + 30 * 60_000;
    const schedule = {
      kind: "every" as const,
      everyMs: 60_000,
      ...(anchorMs === undefined ? {} : { anchorMs }),
    };
    const job = makeCronJob({
      agentId: "main",
      createdAtMs: NOW,
      pacing: { max: "4h" },
      schedule,
      state: { nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot },
    });
    await saveCronStore(state.deps.storePath, { version: 1, jobs: [job] });

    const updated = await update(state, job.id, { description: "edited" });
    const reloaded = await loadCronStore(state.deps.storePath);

    for (const observed of [updated, state.store?.jobs[0], reloaded.jobs[0]]) {
      expect(observed).toMatchObject({
        id: job.id,
        description: "edited",
        state: { nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot },
      });
      expect(observed?.pacing).toEqual({ max: "4h" });
      expect(observed?.schedule).toEqual(schedule);
    }
  },
);

it("requires clearing pacing when converting a recurring job to a one-shot", async () => {
  const job = await add(state, {
    name: "paced job",
    agentId: "main",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    pacing: { min: "15m" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "check" },
  });
  job.state.nextRunAtMs = NOW + 4 * 60 * 60_000;
  job.state.pacedNextRunAtMs = job.state.nextRunAtMs;

  const schedule = { kind: "at", at: "2026-07-19T12:00:00.000Z" } as const;
  await expect(update(state, job.id, { schedule: { ...schedule } })).rejects.toThrow(
    "cron pacing requires an every or cron schedule",
  );
  expect(state.store?.jobs[0]?.schedule.kind).toBe("every");
  expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });

  const updated = await update(state, job.id, { schedule, pacing: null });
  expect(updated.schedule).toEqual(schedule);
  expect(updated.pacing).toBeUndefined();
  expect(updated.state.pacedNextRunAtMs).toBeUndefined();
  expect(updated.state.nextRunAtMs).toBe(Date.parse(schedule.at));
  expect(state.store?.jobs[0]?.schedule).toEqual(schedule);
  expect(state.store?.jobs[0]?.pacing).toBeUndefined();
});
