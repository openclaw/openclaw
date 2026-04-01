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

  it("threads delivery.threadId when explicitly configured", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-1001234567890",
          threadId: "99",
        },
      }),
    );
    expect(plan.mode).toBe("announce");
    expect(plan.requested).toBe(true);
    expect(plan.channel).toBe("telegram");
    expect(plan.to).toBe("-1001234567890");
    expect(plan.threadId).toBe("99");
  });
});

describe("resolveFailureDestination", () => {
  it("merges global defaults with job-level overrides", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: { channel: "signal", mode: "announce" },
        },
      }),
      {
        channel: "telegram",
        to: "222",
        mode: "announce",
        accountId: "global-account",
      },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "signal",
      to: "222",
      accountId: "global-account",
    });
  });

  it("returns null for webhook mode without destination URL", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: { mode: "webhook" },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when failure destination matches primary delivery target", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          accountId: "bot-a",
          failureDestination: {
            mode: "announce",
            channel: "telegram",
            to: "111",
            accountId: "bot-a",
          },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("returns null when webhook failure destination matches the primary webhook target", () => {
    const plan = resolveFailureDestination(
      makeJob({
        sessionTarget: "main",
        payload: { kind: "systemEvent", text: "tick" },
        delivery: {
          mode: "webhook",
          to: "https://example.invalid/cron",
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/cron",
          },
        },
      }),
      undefined,
    );
    expect(plan).toBeNull();
  });

  it("does not reuse inherited announce recipient when switching failure destination to webhook", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "webhook",
          },
        },
      }),
      {
        channel: "signal",
        to: "group-abc",
        mode: "announce",
      },
    );
    expect(plan).toBeNull();
  });

  it("allows job-level failure destination fields to clear inherited global values", () => {
    const plan = resolveFailureDestination(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "111",
          failureDestination: {
            mode: "announce",
            channel: undefined as never,
            to: undefined as never,
            accountId: undefined as never,
          },
        },
      }),
      {
        channel: "signal",
        to: "group-abc",
        accountId: "global-account",
        mode: "announce",
      },
    );
    expect(plan).toEqual({
      mode: "announce",
      channel: "last",
      to: undefined,
      accountId: undefined,
    });
  });
});
