import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { createCronServiceState } from "./service/state.js";
import { runMissedJobs } from "./service/timer.js";

const { logger: noopLogger, makeStorePath } = setupCronServiceSuite({
  prefix: "openclaw-cron-",
  baseTimeIso: "2025-12-13T17:00:00.000Z",
});

describe("CronService restart catch-up", () => {
  async function writeStoreJobs(storePath: string, jobs: unknown[]) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
  }

  function createRestartCronService(params: {
    storePath: string;
    enqueueSystemEvent: ReturnType<typeof vi.fn>;
    requestHeartbeatNow: ReturnType<typeof vi.fn>;
  }) {
    return new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: noopLogger,
      enqueueSystemEvent: params.enqueueSystemEvent as never,
      requestHeartbeatNow: params.requestHeartbeatNow as never,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })) as never,
    });
  }

  function createOverdueEveryJob(id: string, nextRunAtMs: number) {
    return {
      id,
      name: `job-${id}`,
      enabled: true,
      createdAtMs: nextRunAtMs - 60_000,
      updatedAtMs: nextRunAtMs - 60_000,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: nextRunAtMs - 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: `tick-${id}` },
      state: { nextRunAtMs },
    };
  }

  async function withRestartedCron(
    jobs: unknown[],
    run: (params: {
      cron: CronService;
      enqueueSystemEvent: ReturnType<typeof vi.fn>;
      requestHeartbeatNow: ReturnType<typeof vi.fn>;
    }) => Promise<void>,
  ) {
    const store = await makeStorePath();
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();

    await writeStoreJobs(store.storePath, jobs);

    const cron = createRestartCronService({
      storePath: store.storePath,
      enqueueSystemEvent,
      requestHeartbeatNow,
    });

    try {
      await cron.start();
      await run({ cron, enqueueSystemEvent, requestHeartbeatNow });
    } finally {
      cron.stop();
      await store.cleanup();
    }
  }

  it("executes an overdue recurring job immediately on start", async () => {
    const dueAt = Date.parse("2025-12-13T15:00:00.000Z");
    const lastRunAt = Date.parse("2025-12-12T15:00:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-overdue-job",
          name: "daily digest",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-12T15:00:00.000Z"),
          schedule: { kind: "cron", expr: "0 15 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "digest now" },
          state: {
            nextRunAtMs: dueAt,
            lastRunAtMs: lastRunAt,
            lastStatus: "ok",
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "digest now",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-overdue-job");
        expect(updated?.state.lastStatus).toBe("ok");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
        expect(updated?.state.nextRunAtMs).toBeGreaterThan(Date.parse("2025-12-13T17:00:00.000Z"));
      },
    );
  });

  it("replays interrupted recurring job on first restart (#60495)", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-stale-running",
          name: "daily stale marker",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
          schedule: { kind: "cron", expr: "0 16 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "resume stale marker" },
          state: {
            nextRunAtMs: dueAt,
            runningAtMs: staleRunningAt,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(noopLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ jobId: "restart-stale-running" }),
          "cron: clearing stale running marker on startup",
        );

        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "resume stale marker",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-stale-running");
        expect(updated?.state.runningAtMs).toBeUndefined();
        expect(updated?.state.lastStatus).toBe("ok");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T17:00:00.000Z"));
      },
    );
  });
  it("replays the most recent missed cron slot after restart when nextRunAtMs already advanced", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-missed-slot",
          name: "every ten minutes +1",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "catch missed slot" },
          state: {
            // Persisted state may already be recomputed from restart time and
            // point to the future slot, even though 04:01 was missed.
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
            lastStatus: "ok",
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "catch missed slot",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-missed-slot");
        expect(updated?.state.lastRunAtMs).toBe(Date.parse("2025-12-13T04:02:00.000Z"));
      },
    );
  });

  it("does not replay interrupted one-shot jobs on startup", async () => {
    const dueAt = Date.parse("2025-12-13T16:00:00.000Z");
    const staleRunningAt = Date.parse("2025-12-13T16:30:00.000Z");

    await withRestartedCron(
      [
        {
          id: "restart-stale-one-shot",
          name: "one shot stale marker",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T16:30:00.000Z"),
          schedule: { kind: "at", at: "2025-12-13T16:00:00.000Z" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "one-shot stale marker" },
          state: {
            nextRunAtMs: dueAt,
            runningAtMs: staleRunningAt,
          },
        },
      ],
      async ({ cron, enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();

        const listedJobs = await cron.list({ includeDisabled: true });
        const updated = listedJobs.find((job) => job.id === "restart-stale-one-shot");
        expect(updated?.state.runningAtMs).toBeUndefined();
      },
    );
  });

  it("does not replay cron slot when the latest slot already ran before restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-no-duplicate-slot",
          name: "every ten minutes +1 no duplicate",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
          schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "already ran" },
          state: {
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "ok",
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();
      },
    );
  });

  it("does not replay missed cron slots while error backoff is pending after restart", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-backoff-pending",
          name: "backoff pending",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
          schedule: { kind: "cron", expr: "* * * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "do not run during backoff" },
          state: {
            // Next retry is intentionally delayed by backoff despite a newer cron slot.
            nextRunAtMs: Date.parse("2025-12-13T04:10:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T04:01:00.000Z"),
            lastStatus: "error",
            consecutiveErrors: 4,
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();
      },
    );
  });

  it("replays missed cron slot after restart when error backoff has already elapsed", async () => {
    vi.setSystemTime(new Date("2025-12-13T04:02:00.000Z"));
    await withRestartedCron(
      [
        {
          id: "restart-backoff-elapsed-replay",
          name: "backoff elapsed replay",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T04:01:10.000Z"),
          schedule: { kind: "cron", expr: "1,11,21,31,41,51 4-20 * * *", tz: "UTC" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "replay after backoff elapsed" },
          state: {
            // Startup maintenance may already point to a future slot (04:11) even
            // though 04:01 was missed and the 30s error backoff has elapsed.
            nextRunAtMs: Date.parse("2025-12-13T04:11:00.000Z"),
            lastRunAtMs: Date.parse("2025-12-13T03:51:00.000Z"),
            lastStatus: "error",
            consecutiveErrors: 1,
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "replay after backoff elapsed",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();
      },
    );
  });

  it("reschedules deferred missed jobs from the post-catchup clock so they stay in the future", async () => {
    const store = await makeStorePath();
    const startNow = Date.parse("2025-12-13T17:00:00.000Z");
    let now = startNow;

    await writeStoreJobs(store.storePath, [
      createOverdueEveryJob("stagger-0", startNow - 60_000),
      createOverdueEveryJob("stagger-1", startNow - 50_000),
      createOverdueEveryJob("stagger-2", startNow - 40_000),
    ]);

    const state = createCronServiceState({
      cronEnabled: true,
      storePath: store.storePath,
      log: noopLogger,
      nowMs: () => now,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeatNow: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => {
        now += 6_000;
        return { status: "ok" as const, summary: "ok" };
      }),
      maxMissedJobsPerRestart: 1,
      missedJobStaggerMs: 5_000,
    });

    await runMissedJobs(state);

    const staggeredJobs = (state.store?.jobs ?? [])
      .filter((job) => job.id.startsWith("stagger-") && job.id !== "stagger-0")
      .toSorted((a, b) => (a.state.nextRunAtMs ?? 0) - (b.state.nextRunAtMs ?? 0));

    expect(staggeredJobs).toHaveLength(2);
    expect(staggeredJobs[0]?.state.nextRunAtMs).toBeGreaterThan(now);
    expect(staggeredJobs[1]?.state.nextRunAtMs).toBeGreaterThan(
      staggeredJobs[0]?.state.nextRunAtMs ?? 0,
    );
    expect(
      (staggeredJobs[1]?.state.nextRunAtMs ?? 0) - (staggeredJobs[0]?.state.nextRunAtMs ?? 0),
    ).toBe(5_000);

    await store.cleanup();
  });

  // Regression tests for https://github.com/openclaw/openclaw/issues/61028
  // A cron job with a non-UTC tz must use the stored nextRunAtMs (which reflects
  // the tz-correct scheduled slot) to decide whether to fire on restart.  Before
  // the fix, patching a job's expr without re-supplying tz caused nextRunAtMs to
  // be recomputed in the server's local timezone (UTC), producing a UTC-naive value
  // that would trigger spurious catch-up runs on the next restart.

  it("does not spuriously fire a non-UTC job whose tz-correct nextRunAtMs is still in the future (#61028)", async () => {
    // nowMs = 2025-12-13T17:00:00Z (UTC).
    // Job schedule: "0 21 * * *" America/Sao_Paulo (BRT = UTC-3).
    //   → 21:00 BRT = 00:00 UTC next day.
    // Last ran at 00:00 UTC Dec 13 (= 21:00 BRT Dec 12).
    // Tz-correct nextRunAtMs = 00:00 UTC Dec 14 — still 7 hours away.
    // A UTC-naive nextRunAtMs would be 21:00 UTC Dec 13, which has also not
    // yet passed at nowMs=17:00 UTC, so this test specifically confirms the
    // job stays quiet when the tz-correct value is stored.
    const nextRunAtMs = Date.parse("2025-12-14T00:00:00.000Z"); // 21:00 BRT Dec 13
    const lastRunAtMs = Date.parse("2025-12-13T00:00:00.000Z"); // 21:00 BRT Dec 12

    await withRestartedCron(
      [
        {
          id: "brt-future-job",
          name: "BRT daily at 21:00",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-13T00:01:00.000Z"),
          schedule: { kind: "cron", expr: "0 21 * * *", tz: "America/Sao_Paulo" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "BRT tick" },
          state: {
            nextRunAtMs,
            lastRunAtMs,
            lastStatus: "ok",
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        // The next BRT slot is 7 hours away — must NOT fire on restart.
        expect(enqueueSystemEvent).not.toHaveBeenCalled();
        expect(requestHeartbeatNow).not.toHaveBeenCalled();
      },
    );
  });

  it("fires a non-UTC job whose tz-correct nextRunAtMs is overdue on restart (#61028)", async () => {
    // nowMs = 2025-12-13T17:00:00Z (UTC).
    // Job schedule: "0 19 * * *" America/Sao_Paulo (BRT = UTC-3).
    //   → 19:00 BRT = 22:00 UTC.
    // But store has nextRunAtMs = yesterday's 22:00 UTC = 2025-12-12T22:00:00Z,
    // and lastRunAtMs = the run before that.
    // At nowMs=17:00 UTC Dec 13, the previous BRT slot (19:00 BRT Dec 12 = 22:00 UTC Dec 12)
    // was genuinely missed — the job should fire on restart.
    const nextRunAtMs = Date.parse("2025-12-12T22:00:00.000Z"); // 19:00 BRT Dec 12 (missed)
    const lastRunAtMs = Date.parse("2025-12-11T22:00:00.000Z"); // 19:00 BRT Dec 11

    await withRestartedCron(
      [
        {
          id: "brt-overdue-job",
          name: "BRT daily at 19:00",
          enabled: true,
          createdAtMs: Date.parse("2025-12-10T12:00:00.000Z"),
          updatedAtMs: Date.parse("2025-12-12T22:01:00.000Z"),
          schedule: { kind: "cron", expr: "0 19 * * *", tz: "America/Sao_Paulo" },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "BRT overdue tick" },
          state: {
            nextRunAtMs,
            lastRunAtMs,
            lastStatus: "ok",
          },
        },
      ],
      async ({ enqueueSystemEvent, requestHeartbeatNow }) => {
        // The 19:00 BRT Dec 12 slot was missed — must fire on restart.
        expect(enqueueSystemEvent).toHaveBeenCalledWith(
          "BRT overdue tick",
          expect.objectContaining({ agentId: undefined }),
        );
        expect(requestHeartbeatNow).toHaveBeenCalled();
      },
    );
  });
});
