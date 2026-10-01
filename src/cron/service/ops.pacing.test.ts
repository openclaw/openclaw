import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { setupCronServiceSuite } from "../service.test-harness.js";
import type { CronJobCreate, CronPacing } from "../types.js";
import { add, update } from "./ops-mutations.js";
import { createCronServiceState } from "./state.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-pacing-ops" });
const NOW = Date.parse("2026-07-18T12:00:00.000Z");

function makeInput(pacing: CronPacing): CronJobCreate {
  return {
    name: "paced job",
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
  it("preserves a pending paced slot on an unrelated edit", async () => {
    await withState(async (state) => {
      const job = await add(state, makeInput({ max: "4h" }));
      job.state.pacedNextRunAtMs = job.state.nextRunAtMs;

      const updated = await update(state, job.id, { description: "edited" });

      expect(updated.pacing).toEqual({ max: "4h" });
      expect(updated.state.nextRunAtMs).toBe(job.state.nextRunAtMs);
      expect(updated.state.pacedNextRunAtMs).toBe(job.state.pacedNextRunAtMs);
    });
  });

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
