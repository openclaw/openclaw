import { describe, expect, it } from "vitest";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import { normalizeStoredCronJobs } from "./store-migration.js";

function makeLegacyJob(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "job-legacy",
    agentId: undefined,
    name: "Legacy job",
    description: null,
    enabled: true,
    deleteAfterRun: false,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: "systemEvent",
      text: "tick",
    },
    state: {},
    ...overrides,
  };
}

function normalizeOneJob(job: Record<string, unknown>) {
  const jobs = [job];
  const result = normalizeStoredCronJobs(jobs);
  return { job: jobs[0], result };
}

describe("normalizeStoredCronJobs legacy schedule and delivery behavior", () => {
  it("normalizes isolated legacy jobs without mutating runtime code paths", () => {
    const { job, result } = normalizeOneJob(
      makeLegacyJob({
        id: "job-1",
        sessionKey: "  agent:main:discord:channel:ops  ",
        schedule: { kind: "at", atMs: 1_700_000_000_000 },
        sessionTarget: "isolated",
        payload: {
          kind: "agentTurn",
          message: "hi",
          deliver: true,
          channel: "telegram",
          to: "7200373102",
          bestEffortDeliver: true,
        },
        isolation: { postToMainPrefix: "Cron" },
      }),
    );

    expect(result.mutated).toBe(true);
    expect(job.sessionKey).toBe("agent:main:discord:channel:ops");
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "7200373102",
      bestEffort: true,
    });
    expect("isolation" in job).toBe(false);

    const payload = job.payload as Record<string, unknown>;
    expect(payload.deliver).toBeUndefined();
    expect(payload.channel).toBeUndefined();
    expect(payload.to).toBeUndefined();
    expect(payload.bestEffortDeliver).toBeUndefined();

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("at");
    expect(schedule.at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(schedule.atMs).toBeUndefined();
  });

  it("preserves stored custom session targets", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-custom-session",
        name: "Custom session",
        schedule: { kind: "cron", expr: "0 23 * * *", tz: "UTC" },
        sessionTarget: "session:ProjectAlpha",
        payload: {
          kind: "agentTurn",
          message: "hello",
        },
      }),
    );

    expect(job.sessionTarget).toBe("session:ProjectAlpha");
    expect(job.delivery).toEqual({ mode: "announce" });
  });

  it("adds anchorMs to legacy every schedules", () => {
    const createdAtMs = 1_700_000_000_000;
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-every-legacy",
        name: "Legacy every",
        createdAtMs,
        updatedAtMs: createdAtMs,
        schedule: { kind: "every", everyMs: 120_000 },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("every");
    expect(schedule.anchorMs).toBe(createdAtMs);
  });

  it("adds default staggerMs to legacy recurring top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-legacy",
        name: "Legacy cron",
        schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("adds default staggerMs to legacy 6-field top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-seconds-legacy",
        name: "Legacy cron seconds",
        schedule: { kind: "cron", expr: "0 0 */3 * * *", tz: "UTC" },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
  });

  it("removes invalid legacy staggerMs from non top-of-hour cron schedules", () => {
    const { job } = normalizeOneJob(
      makeLegacyJob({
        id: "job-cron-minute-legacy",
        name: "Legacy minute cron",
        schedule: {
          kind: "cron",
          expr: "17 * * * *",
          tz: "UTC",
          staggerMs: "bogus",
        },
      }),
    );

    const schedule = job.schedule as Record<string, unknown>;
    expect(schedule.kind).toBe("cron");
    expect(schedule.staggerMs).toBeUndefined();
  });

  it("migrates legacy string schedules and command-only payloads (#18445)", () => {
    const { job, result } = normalizeOneJob({
      id: "imessage-refresh",
      name: "iMessage Refresh",
      enabled: true,
      createdAtMs: 1_700_000_000_000,
      updatedAtMs: 1_700_000_000_000,
      schedule: "0 */2 * * *",
      command: "bash /tmp/imessage-refresh.sh",
      timeout: 120,
      state: {},
    });

    expect(result.mutated).toBe(true);
    expect(job.schedule).toEqual(
      expect.objectContaining({
        kind: "cron",
        expr: "0 */2 * * *",
      }),
    );
    expect(job.sessionTarget).toBe("main");
    expect(job.wakeMode).toBe("now");
    expect(job.payload).toEqual({
      kind: "systemEvent",
      text: "bash /tmp/imessage-refresh.sh",
    });
    expect("command" in job).toBe(false);
    expect("timeout" in job).toBe(false);
  });
});
