import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan, resolveFailureDestination } from "./delivery.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    state: {},
    ...overrides,
  };
}

describe("resolveCronDeliveryPlan", () => {
  it("defaults to announce when delivery object has no mode", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { channel: "telegram", to: "123", mode: undefined as never },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
  });

  it("respects legacy payload deliver=false", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: undefined,
        payload: { kind: "agentTurn", message: "hello", deliver: false },
      }),
    );
    expect(plan.mode).toBe("none");
    expect(plan.requested).toBe(false);
  });

  it("resolves mode=none with requested=false and no channel (#21808)", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { mode: "none", to: "telegram:123" },
      }),
    );
    expect(plan.mode).toBe("none");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("telegram:123");
  });

  it("resolves webhook mode without channel routing", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { mode: "webhook", to: "https://example.invalid/cron" },
      }),
    );
    expect(plan.mode).toBe("webhook");
    expect(plan.requested).toBe(false);
    expect(plan.channel).toBeUndefined();
    expect(plan.to).toBe("https://example.invalid/cron");
  });

  it("threads delivery.accountId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          accountId: " bot-a ",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("123");
    expect(plan.accountId).toBe("bot-a");
  });
});

describe("resolveFailureDestination", () => {
  it("returns null when no failureDestination configured", () => {
    const job = makeJob({
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });
    const result = resolveFailureDestination(job);
    expect(result).toBeNull();
  });

  it("returns job-level failureDestination", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        failureDestination: {
          channel: "slack",
          to: "#alerts",
          mode: "announce",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).not.toBeNull();
    expect(result?.mode).toBe("announce");
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBe("#alerts");
  });

  it("falls back to global config when job has no failureDestination", () => {
    const job = makeJob({
      delivery: { mode: "announce", channel: "telegram", to: "123" },
    });
    const globalConfig = {
      channel: "slack",
      to: "#global-alerts",
      mode: "webhook" as const,
    };
    const result = resolveFailureDestination(job, globalConfig);
    expect(result).not.toBeNull();
    expect(result?.mode).toBe("webhook");
    // webhook mode uses 'to' field for URL, channel is not applicable
    expect(result?.channel).toBeUndefined();
    expect(result?.to).toBe("#global-alerts");
  });

  it("job config takes priority over global config", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        failureDestination: {
          channel: "discord",
          to: "job-channel",
        },
      },
    });
    const globalConfig = {
      channel: "slack",
      to: "#global-alerts",
    };
    const result = resolveFailureDestination(job, globalConfig);
    expect(result?.channel).toBe("discord");
    expect(result?.to).toBe("job-channel");
  });

  it("returns null when all fields are empty in job config", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        failureDestination: {},
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).toBeNull();
  });

  it("returns null when only accountId is set but not in global", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        failureDestination: {
          accountId: "my-account",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).not.toBeNull();
    expect(result?.accountId).toBe("my-account");
    expect(result?.channel).toBe("last");
  });

  it("webhook mode stores URL in to field", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        failureDestination: {
          to: "https://hooks.example.com/alerts",
          mode: "webhook",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).not.toBeNull();
    expect(result?.mode).toBe("webhook");
    expect(result?.to).toBe("https://hooks.example.com/alerts");
    expect(result?.channel).toBeUndefined();
  });

  it("normalizes channel to lowercase", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        failureDestination: {
          channel: "TELEGRAM",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result?.channel).toBe("telegram");
  });

  it("uses default announce mode when mode not specified", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        failureDestination: {
          channel: "slack",
          to: "#alerts",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result?.mode).toBe("announce");
  });

  it("returns null when failureDestination matches primary delivery (duplicate prevention)", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        failureDestination: {
          channel: "telegram",
          to: "123",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).toBeNull();
  });

  it("returns null when failureDestination webhook matches primary webhook", () => {
    const job = makeJob({
      delivery: {
        mode: "webhook",
        to: "https://example.com/webhook",
        failureDestination: {
          to: "https://example.com/webhook",
          mode: "webhook",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).toBeNull();
  });

  it("allows different failureDestination from primary delivery", () => {
    const job = makeJob({
      delivery: {
        mode: "announce",
        channel: "telegram",
        to: "123",
        failureDestination: {
          channel: "slack",
          to: "#alerts",
        },
      },
    });
    const result = resolveFailureDestination(job);
    expect(result).not.toBeNull();
    expect(result?.channel).toBe("slack");
    expect(result?.to).toBe("#alerts");
  });
});
