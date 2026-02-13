import { describe, expect, it } from "vitest";
import type { CronDelivery } from "./types.js";
import { normalizeCronJobCreate } from "./normalize.js";

describe("normalizeCronJobCreate delivery threadId", () => {
  it("preserves string threadId in delivery", () => {
    const normalized = normalizeCronJobCreate({
      name: "thread-test",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      delivery: {
        mode: "announce",
        channel: "slack",
        to: "C123",
        threadId: " 1770906236.804979 ",
      },
    });
    expect(normalized).not.toBeNull();
    const delivery = normalized!.delivery as CronDelivery;
    expect(delivery.threadId).toBe("1770906236.804979");
  });

  it("preserves numeric threadId in delivery", () => {
    const normalized = normalizeCronJobCreate({
      name: "thread-num",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      delivery: { mode: "announce", channel: "telegram", to: "123", threadId: 42 },
    });
    expect(normalized).not.toBeNull();
    const delivery = normalized!.delivery as CronDelivery;
    expect(delivery.threadId).toBe(42);
  });

  it("strips empty string threadId", () => {
    const normalized = normalizeCronJobCreate({
      name: "thread-empty",
      schedule: { kind: "cron", expr: "* * * * *" },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "hi" },
      delivery: { mode: "announce", channel: "slack", to: "C123", threadId: "  " },
    });
    expect(normalized).not.toBeNull();
    const delivery = normalized!.delivery as CronDelivery;
    expect(delivery.threadId).toBeUndefined();
  });
});
