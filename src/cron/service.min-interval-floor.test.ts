import { describe, expect, it, vi } from "vitest";
import type { CronConfig } from "../config/types.cron.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";
import type { CronJob, CronJobState, CronSchedule } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-min-interval-floor-",
});

const BASE = Date.parse("2025-12-13T00:00:00.000Z");
const FLOOR_MS = 300_000;
// Mirrors CRON_MIN_INTERVAL_DISPATCH_SLACK_MS in service/jobs.ts.
const SLACK_MS = 2_000;
const FLOOR_DEFER_WARNING = "cron: next fire deferred to the cron.minInterval floor";

// Seeds jobs directly into the store: pre-existing jobs bypass the
// create/update minInterval validation, which is exactly the scenario the
// fire-time floor must cover.
function seededJob(params: {
  id: string;
  schedule: CronSchedule;
  state: CronJobState;
  isolated?: boolean;
}): CronJob {
  return {
    id: params.id,
    name: params.id,
    enabled: true,
    createdAtMs: BASE - 60_000,
    updatedAtMs: BASE - 60_000,
    schedule: params.schedule,
    sessionTarget: params.isolated ? "isolated" : "main",
    wakeMode: "now",
    payload: params.isolated
      ? { kind: "agentTurn", message: "tick" }
      : { kind: "systemEvent", text: "tick" },
    state: params.state,
  };
}

function createService(params: {
  storePath: string;
  cronConfig?: CronConfig;
  runIsolatedAgentJob?: () => Promise<{ status: "ok" } | { status: "error"; error: string }>;
}) {
  return new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob:
      params.runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
    cronConfig: params.cronConfig,
  });
}

async function seedAndStart(params: {
  job: CronJob;
  cronConfig?: CronConfig;
  runIsolatedAgentJob?: () => Promise<{ status: "ok" } | { status: "error"; error: string }>;
}) {
  const store = await makeStorePath();
  await writeCronStoreSnapshot({ storePath: store.storePath, jobs: [params.job] });
  const cron = createService({
    storePath: store.storePath,
    cronConfig: params.cronConfig,
    runIsolatedAgentJob: params.runIsolatedAgentJob,
  });
  await cron.start();
  return { cron, store };
}

async function loadJob(cron: CronService, id: string) {
  return (await cron.list({ includeDisabled: true })).find((job) => job.id === id);
}

describe("cron.minInterval fire-time floor", () => {
  it("paces a pre-existing every job below the floor and warns", async () => {
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "fast-every",
        schedule: { kind: "every", everyMs: 30_000 },
        state: { nextRunAtMs: BASE + 30_000 },
      }),
      cronConfig: { minInterval: "5m" },
    });

    vi.setSystemTime(new Date(BASE + 30_000));
    await expect(cron.run("fast-every", "due")).resolves.toEqual({ ok: true, ran: true });

    const job = await loadJob(cron, "fast-every");
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.nextRunAtMs).toBe(BASE + 30_000 + FLOOR_MS - SLACK_MS);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "fast-every" }),
      FLOOR_DEFER_WARNING,
    );

    cron.stop();
    await store.cleanup();
  });

  it("paces a cron-expression job whose natural next fire is below the floor", async () => {
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "minutely-cron",
        schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
        state: { nextRunAtMs: BASE + 60_000 },
      }),
      cronConfig: { minInterval: "5m" },
    });

    vi.setSystemTime(new Date(BASE + 60_000));
    await expect(cron.run("minutely-cron", "due")).resolves.toEqual({ ok: true, ran: true });

    const job = await loadJob(cron, "minutely-cron");
    expect(job?.state.lastStatus).toBe("ok");
    expect(job?.state.nextRunAtMs).toBe(BASE + 60_000 + FLOOR_MS - SLACK_MS);

    cron.stop();
    await store.cleanup();
  });

  it("keeps natural rearm cadence when no floor is configured", async () => {
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "fast-every-unlimited",
        schedule: { kind: "every", everyMs: 30_000 },
        state: { nextRunAtMs: BASE + 30_000 },
      }),
    });

    vi.setSystemTime(new Date(BASE + 30_000));
    await expect(cron.run("fast-every-unlimited", "due")).resolves.toEqual({
      ok: true,
      ran: true,
    });

    const job = await loadJob(cron, "fast-every-unlimited");
    expect(job?.state.nextRunAtMs).toBe(BASE + 60_000);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), FLOOR_DEFER_WARNING);

    cron.stop();
    await store.cleanup();
  });

  it("does not defer or warn for a compliant schedule fired with dispatch jitter", async () => {
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "at-floor-every",
        schedule: { kind: "every", everyMs: FLOOR_MS },
        state: { nextRunAtMs: BASE + FLOOR_MS, lastRunAtMs: BASE },
      }),
      cronConfig: { minInterval: "5m" },
    });

    // Fire 150ms late: the slack must absorb the jitter so the at-floor
    // schedule keeps its natural cadence instead of drifting forever.
    vi.setSystemTime(new Date(BASE + FLOOR_MS + 150));
    await expect(cron.run("at-floor-every", "due")).resolves.toEqual({ ok: true, ran: true });

    const job = await loadJob(cron, "at-floor-every");
    expect(job?.state.nextRunAtMs).toBeGreaterThanOrEqual(BASE + 2 * FLOOR_MS);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), FLOOR_DEFER_WARNING);

    cron.stop();
    await store.cleanup();
  });

  it("bounds post-error rearm so failing fast jobs cannot out-fire the floor", async () => {
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "failing-fast",
        schedule: { kind: "every", everyMs: 30_000 },
        state: { nextRunAtMs: BASE + 30_000 },
        isolated: true,
      }),
      cronConfig: { minInterval: "5m" },
      runIsolatedAgentJob: vi.fn(async () => ({ status: "error" as const, error: "boom" })),
    });

    vi.setSystemTime(new Date(BASE + 30_000));
    const result = await cron.run("failing-fast", "due");
    expect(result).toMatchObject({ ok: true, ran: true });

    const job = await loadJob(cron, "failing-fast");
    expect(job?.state.lastStatus).toBe("error");
    // Error backoff alone (30s) would rearm sooner; the floor must win.
    expect(job?.state.nextRunAtMs).toBe(BASE + 30_000 + FLOOR_MS - SLACK_MS);

    cron.stop();
    await store.cleanup();
  });

  it("manual force runs preserve the schedule instead of re-anchoring the floor", async () => {
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "compliant-every",
        schedule: { kind: "every", everyMs: 600_000 },
        state: { nextRunAtMs: BASE + 600_000, lastRunAtMs: BASE },
      }),
      cronConfig: { minInterval: "5m" },
    });

    vi.setSystemTime(new Date(BASE + 540_000));
    await expect(cron.run("compliant-every", "force")).resolves.toEqual({ ok: true, ran: true });

    const job = await loadJob(cron, "compliant-every");
    // The forced run must not push the scheduled fire to forcedStart+floor.
    expect(job?.state.nextRunAtMs).toBe(BASE + 600_000);
    expect(logger.warn).not.toHaveBeenCalledWith(expect.anything(), FLOOR_DEFER_WARNING);

    cron.stop();
    await store.cleanup();
  });

  it("keeps the floor across enable-toggle updates", async () => {
    const flooredNextRunAtMs = BASE + FLOOR_MS - SLACK_MS;
    const { cron, store } = await seedAndStart({
      job: seededJob({
        id: "toggled-fast",
        schedule: { kind: "every", everyMs: 30_000 },
        state: { nextRunAtMs: flooredNextRunAtMs, lastRunAtMs: BASE, lastStatus: "ok" },
      }),
      cronConfig: { minInterval: "5m" },
    });

    // A bare {enabled: true} update used to reset the deferred fire back to
    // the natural (too fast) slot, letting an agent defeat the floor.
    vi.setSystemTime(new Date(BASE + 60_000));
    await cron.update("toggled-fast", { enabled: true });

    const job = await loadJob(cron, "toggled-fast");
    expect(job?.state.nextRunAtMs).toBe(flooredNextRunAtMs);

    cron.stop();
    await store.cleanup();
  });

  it("startup catch-up does not replay a missed slot inside the floor window", async () => {
    const store = await makeStorePath();
    const flooredNextRunAtMs = BASE + FLOOR_MS - SLACK_MS;
    await writeCronStoreSnapshot({
      storePath: store.storePath,
      jobs: [
        seededJob({
          id: "restarted-cron",
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          state: { nextRunAtMs: flooredNextRunAtMs, lastRunAtMs: BASE, lastStatus: "ok" },
        }),
      ],
    });

    // Restart 90s after the last fire: a natural slot elapsed, but replaying
    // it would undo the deferred fire and violate the floor.
    const enqueueSystemEvent = vi.fn();
    const state = createCronServiceState({
      storePath: store.storePath,
      cronEnabled: true,
      log: logger,
      nowMs: () => BASE + 90_000,
      enqueueSystemEvent,
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      cronConfig: { minInterval: "5m" },
    });
    await runMissedJobs(state);

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    const job = state.store?.jobs.find((entry) => entry.id === "restarted-cron");
    expect(job?.state.nextRunAtMs).toBe(flooredNextRunAtMs);

    await store.cleanup();
  });
});
