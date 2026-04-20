import { describe, expect, it } from "vitest";
import { resolveCronDeliveryPlan } from "./delivery-plan.js";

describe("resolveCronDeliveryPlan", () => {
  it("preserves explicit message target context for delivery.mode=none", () => {
    const plan = resolveCronDeliveryPlan({
      id: "cron-target-context",
      name: "Cron Target Context",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      payload: { kind: "agentTurn", message: "send a message" },
      delivery: {
        mode: "none",
        channel: "telegram",
        to: "123:topic:42",
        threadId: 42,
        accountId: "ops",
      },
    });

    expect(plan).toEqual({
      mode: "none",
      channel: "telegram",
      to: "123:topic:42",
      threadId: 42,
      accountId: "ops",
      source: "delivery",
      requested: false,
    });
  });
});
