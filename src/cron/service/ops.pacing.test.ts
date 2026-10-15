import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import { loadCronStore, saveCronStore } from "../store.js";
import type { CronJobCreate, CronPacing } from "../types.js";
import { add, update } from "./ops-mutations.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pacing-ops" });
const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function makeInput(pacing: CronPacing): CronJobCreate {
  return {
    name: "paced job",
    agentId: "main",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    pacing,
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "check" },
  };
}

async function withState(run: (state: ReturnType<typeof createCronServiceState>) => Promise<void>) {
  const { storePath } = await makeStorePath();
  await run(
    createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => NOW,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    }),
  );
}

describe("cron pacing validation", () => {
  it.each([
    { label: "an authored anchor", anchorMs: NOW },
    { label: "a missing anchor", anchorMs: undefined },
  ])(
    "preserves a pending paced slot and schedule on an unrelated edit with $label",
    async ({ anchorMs }) => {
      await withState(async (state) => {
        const pendingSlot = NOW + 30 * 60_000;
        const schedule = {
          kind: "every" as const,
          everyMs: 60_000,
          ...(anchorMs === undefined ? {} : { anchorMs }),
        };
        const job = makeCronJob({
          id: "pending-paced-edit",
          agentId: "main",
          createdAtMs: NOW,
          updatedAtMs: NOW,
          pacing: { max: "4h" },
          schedule,
          state: { nextRunAtMs: pendingSlot, pacedNextRunAtMs: pendingSlot },
        });
        await saveCronStore(state.deps.storePath, { version: 1, jobs: [job] });

        const updated = await update(state, job.id, { description: "edited" });
        const reloaded = await loadCronStore(state.deps.storePath);

        for (const observed of [updated, state.store?.jobs[0], reloaded.jobs[0]]) {
          expect(observed?.id).toBe(job.id);
          expect(observed?.description).toBe("edited");
          expect(observed?.schedule).toEqual(schedule);
          expect(observed?.pacing).toEqual({ max: "4h" });
          expect(observed?.state.nextRunAtMs).toBe(pendingSlot);
          expect(observed?.state.pacedNextRunAtMs).toBe(pendingSlot);
        }
      });
    },
  );

  it("requires clearing pacing when converting a recurring job to a one-shot", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ min: "15m" }));
      job.state.nextRunAtMs = NOW + 4 * 60 * 60_000;
      job.state.pacedNextRunAtMs = job.state.nextRunAtMs;

      await expect(
        update(state, job.id, {
          schedule: { kind: "at", at: "2026-07-19T12:00:00.000Z" },
        }),
      ).rejects.toThrow("cron pacing requires an every or cron schedule");
      expect(state.store?.jobs[0]?.schedule.kind).toBe("every");
      expect(state.store?.jobs[0]?.pacing).toEqual({ min: "15m" });

      const schedule = { kind: "at", at: "2026-07-19T12:00:00.000Z" } as const;
      const updated = await update(state, job.id, { schedule, pacing: null });
      expect(updated.schedule).toEqual(schedule);
      expect(updated.pacing).toBeUndefined();
      expect(updated.state.pacedNextRunAtMs).toBeUndefined();
      expect(updated.state.nextRunAtMs).toBe(Date.parse(schedule.at));
      expect(state.store?.jobs[0]?.schedule).toEqual(schedule);
      expect(state.store?.jobs[0]?.pacing).toBeUndefined();
    });
  });
});
