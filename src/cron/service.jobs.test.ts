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

  const createMainSystemEventJob = (id: string, delivery: CronJob["delivery"]): CronJob => {
    return createIsolatedAgentTurnJob(id, delivery, {
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "ping" },
    });
  };

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

  it("merges delivery.accountId from patch and preserves existing", () => {
    const job = createIsolatedAgentTurnJob("job-acct", {
      mode: "announce",
      channel: "telegram",
      to: "-100123",
    });

    applyJobPatch(job, { delivery: { mode: "announce", accountId: " coordinator " } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.mode).toBe("announce");
    expect(job.delivery?.to).toBe("-100123");

    // Updating other fields preserves accountId
    applyJobPatch(job, { delivery: { mode: "announce", to: "-100999" } });
    expect(job.delivery?.accountId).toBe("coordinator");
    expect(job.delivery?.to).toBe("-100999");

    // Clearing accountId with empty string
    applyJobPatch(job, { delivery: { mode: "announce", accountId: "" } });
    expect(job.delivery?.accountId).toBeUndefined();
  });

  it("rejects webhook delivery without a valid http(s) target URL", () => {
    const expectedError = "cron webhook delivery requires delivery.to to be a valid http(s) URL";
    const cases = [
      { name: "no delivery update", patch: { enabled: true } satisfies CronJobPatch },
      {
        name: "blank webhook target",
        patch: { delivery: { mode: "webhook", to: "" } } satisfies CronJobPatch,
      },
      {
        name: "non-http protocol",
        patch: {
          delivery: { mode: "webhook", to: "ftp://example.invalid" },
        } satisfies CronJobPatch,
      },
      {
        name: "invalid URL",
        patch: { delivery: { mode: "webhook", to: "not-a-url" } } satisfies CronJobPatch,
      },
    ] as const;

    for (const testCase of cases) {
      const job = createMainSystemEventJob("job-webhook-invalid", { mode: "webhook" });
      expect(() => applyJobPatch(job, testCase.patch), testCase.name).toThrow(expectedError);
    }
  });

  it("trims webhook delivery target URLs", () => {
    const job = createMainSystemEventJob("job-webhook-trim", {
      mode: "webhook",
      to: "https://example.invalid/original",
    });

    expect(() =>
      applyJobPatch(job, { delivery: { mode: "webhook", to: "  https://example.invalid/trim  " } }),
    ).not.toThrow();
    expect(job.delivery).toEqual({ mode: "webhook", to: "https://example.invalid/trim" });
  });

  it("rejects Telegram delivery with invalid target (chatId/topicId format)", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-invalid", {
      mode: "announce",
      channel: "telegram",
      to: "-10012345/6789",
    });

    expect(() => applyJobPatch(job, { enabled: true })).toThrow(
      'Invalid Telegram delivery target "-10012345/6789". Use colon (:) as delimiter for topics, not slash. Valid formats: -1001234567890, -1001234567890:123, -1001234567890:topic:123, @username, https://t.me/username',
    );
  });

  it("accepts Telegram delivery with t.me URL", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-tme", {
      mode: "announce",
      channel: "telegram",
      to: "https://t.me/mychannel",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });

  it("accepts Telegram delivery with t.me URL (no https)", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-tme-no-https", {
      mode: "announce",
      channel: "telegram",
      to: "t.me/mychannel",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });

  it("accepts Telegram delivery with valid target (plain chat id)", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-valid", {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });

  it("accepts Telegram delivery with valid target (colon delimiter)", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-valid-colon", {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:123",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });

  it("accepts Telegram delivery with valid target (topic marker)", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-valid-topic", {
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890:topic:456",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });

  it("accepts Telegram delivery without target", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-no-target", {
      mode: "announce",
      channel: "telegram",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
  });

  it("accepts Telegram delivery with @username", () => {
    const job = createIsolatedAgentTurnJob("job-telegram-username", {
      mode: "announce",
      channel: "telegram",
      to: "@mybot",
    });

    expect(() => applyJobPatch(job, { enabled: true })).not.toThrow();
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
