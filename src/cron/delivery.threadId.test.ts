import { describe, expect, it } from "vitest";
import type { CronJob } from "./types.js";
import { resolveCronDeliveryPlan } from "./delivery.js";

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

describe("resolveCronDeliveryPlan threadId", () => {
  it("extracts threadId from delivery object", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "slack",
          to: "C123",
          threadId: "1770906236.804979",
        },
      }),
    );
    expect(plan.threadId).toBe("1770906236.804979");
  });

  it("extracts numeric threadId", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "123",
          threadId: 42,
        },
      }),
    );
    expect(plan.threadId).toBe(42);
  });

  it("returns undefined threadId when not set", () => {
    const plan = resolveCronDeliveryPlan(
      makeJob({
        delivery: { mode: "announce", channel: "slack", to: "C123" },
      }),
    );
    expect(plan.threadId).toBeUndefined();
  });
});
