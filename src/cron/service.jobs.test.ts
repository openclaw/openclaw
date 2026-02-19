import { describe, expect, it } from "vitest";
import { applyJobPatch, createJob } from "./service/jobs.js";
import type { CronServiceState } from "./service/state.js";
import { DEFAULT_TOP_OF_HOUR_STAGGER_MS } from "./stagger.js";
import type { CronJob, CronJobPatch } from "./types.js";

describe("applyJobPatch", () => {
  const createIsolatedAgentTurnJob = (
    id: string,
    delivery: CronJob["delivery"],
    overrides?: Partial<CronJob>,
  ): CronJob => {
    const now = Date.now();
    return {
      id,
      name: id,
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "do it" },
      delivery,
      state: {},
      ...overrides,
    };
  };

  const switchToMainPatch = (): CronJobPatch => ({
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "ping" },
  });

  it("clears delivery when switching to main session", () => {
    const job = createIsolatedAgentTurnJob("job-1", {
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    expect(() => applyJobPatch(job, switchToMainPatch())).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.payload.kind).toBe("systemEvent");
    expect(job.delivery).toBeUndefined();
  });

  it("keeps webhook delivery when switching to main session", () => {
    const job = createIsolatedAgentTurnJob("job-webhook", {
      mode: "webhook",
      to: "https://example.invalid/cron",
    });

    expect(() => applyJobPatch(job, switchToMainPatch())).not.toThrow();
    expect(job.sessionTarget).toBe("main");
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/cron" });
  });

  it("maps legacy payload delivery updates onto delivery", () => {
    const job = createIsolatedAgentTurnJob("job-2", {
      mode: "announce",
      channel: "telegram",
      to: "123",
    });

    const patch: CronJobPatch = {
      payload: {
        kind: "agentTurn",
        deliver: false,
        channel: "Signal",
        to: "555",
        bestEffortDeliver: true,
      },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.payload.kind).toBe("agentTurn");
    if (job.payload.kind === "agentTurn") {
      expect(job.payload.deliver).toBe(false);
      expect(job.payload.channel).toBe("Signal");
      expect(job.payload.to).toBe("555");
      expect(job.payload.bestEffortDeliver).toBe(true);
    }
    expect(job.delivery).toEqual({
      mode: "none",
      channel: "signal",
      to: "555",
      bestEffort: true,
    });
  });

  it("treats legacy payload targets as announce requests", () => {
    const job = createIsolatedAgentTurnJob("job-3", {
      mode: "none",
      channel: "telegram",
    });

    const patch: CronJobPatch = {
      payload: { kind: "agentTurn", to: " 999 " },
    };

    expect(() => applyJobPatch(job, patch)).not.toThrow();
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "999",
      bestEffort: undefined,
    });
  });

  it("rejects webhook delivery without a valid http(s) target URL", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-webhook-invalid",
      name: "job-webhook-invalid",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
      delivery: { mode: "webhook" },
      state: {},
    };

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
    expect(() => applyJobPatch(job, { delivery: { mode: "webhook", to: "" } })).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "ftp://example.invalid" } }),
    ).toThrow("cron webhook delivery requires delivery.to to be a valid http(s) URL");
    expect(() => applyJobPatch(job, { delivery: { mode: "webhook", to: "not-a-url" } })).toThrow(
      "cron webhook delivery requires delivery.to to be a valid http(s) URL",
    );
  });

  it("trims webhook delivery target URLs", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-webhook-trim",
      name: "job-webhook-trim",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "ping" },
      delivery: { mode: "webhook", to: "https://example.invalid/original" },
      state: {},
    };

    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "  https://example.invalid/trim  " } }),
    ).not.toThrow();
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/trim" });
  });
});

function createMockState(now: number): CronServiceState {
  return {
    deps: {
      nowMs: () => now,
    },
  } as unknown as CronServiceState;
}

describe("cron stagger defaults", () => {
  it("defaults top-of-hour cron jobs to 5m stagger", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      name: "hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    }
  });

  it("keeps exact schedules when staggerMs is explicitly 0", () => {
    const now = Date.parse("2026-02-08T10:00:00.000Z");
    const state = createMockState(now);

    const job = createJob(state, {
      name: "exact-hourly",
      enabled: true,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.staggerMs).toBe(0);
    }
  });

  it("preserves existing stagger when editing cron expression without stagger", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-keep-stagger",
      name: "job-keep-stagger",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC", staggerMs: 120_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };

    applyJobPatch(job, {
      schedule: { kind: "cron", expr: "0 */2 * * *", tz: "UTC" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.expr).toBe("0 */2 * * *");
      expect(job.schedule.staggerMs).toBe(120_000);
    }
  });

  it("applies default stagger when switching from every to top-of-hour cron", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "job-switch-cron",
      name: "job-switch-cron",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "tick" },
      state: {},
    };

    applyJobPatch(job, {
      schedule: { kind: "cron", expr: "0 * * * *", tz: "UTC" },
    });

    expect(job.schedule.kind).toBe("cron");
    if (job.schedule.kind === "cron") {
      expect(job.schedule.staggerMs).toBe(DEFAULT_TOP_OF_HOUR_STAGGER_MS);
    }
  });
});
