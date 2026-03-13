import { describe, expect, it } from "vitest";
import type { CronJob } from "../types.js";
import { resolveDeliveryStatus } from "./timer.js";

function makeJob(delivery?: { mode?: string }): CronJob {
  return {
    id: "test-job",
    name: "test",
    schedule: { kind: "every", everyMs: 60_000 },
    payload: { kind: "agentTurn", message: "hello" },
    sessionTarget: "isolated",
    enabled: true,
    state: {},
    ...(delivery ? { delivery } : {}),
  } as CronJob;
}

describe("resolveDeliveryStatus", () => {
  it('returns "not-requested" when delivery.mode is "none" and delivered is false', () => {
    const job = makeJob({ mode: "none" });
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-requested");
  });

  it('returns "not-requested" when delivery.mode is "none" and delivered is undefined', () => {
    const job = makeJob({ mode: "none" });
    expect(resolveDeliveryStatus({ job })).toBe("not-requested");
  });

  it('returns "delivered" when delivery.mode is "none" but delivered is true', () => {
    // A messaging-tool send or other path can mark delivered=true even when
    // cron delivery was not configured. That real delivery should be reported.
    const job = makeJob({ mode: "none" });
    expect(resolveDeliveryStatus({ job, delivered: true })).toBe("delivered");
  });

  it('returns "delivered" when delivery is requested and delivered is true', () => {
    const job = makeJob({ mode: "announce" });
    expect(resolveDeliveryStatus({ job, delivered: true })).toBe("delivered");
  });

  it('returns "not-delivered" when delivery is requested and delivered is false', () => {
    const job = makeJob({ mode: "announce" });
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-delivered");
  });

  it('returns "unknown" when delivery is requested and delivered is undefined', () => {
    const job = makeJob({ mode: "announce" });
    expect(resolveDeliveryStatus({ job })).toBe("unknown");
  });
});
