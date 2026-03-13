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
  // mode="none" tests
  it('returns "not-requested" when delivery.mode is "none" and delivered is false', () => {
    const job = makeJob({ mode: "none" });
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-requested");
  });

  it('returns "not-requested" when delivery.mode is "none" and delivered is undefined', () => {
    const job = makeJob({ mode: "none" });
    expect(resolveDeliveryStatus({ job })).toBe("not-requested");
  });

  it('returns "delivered" when delivery.mode is "none" but delivered is true', () => {
    // Even when cron doesn't configure delivery, manual delivery via messaging tools is possible
    const job = makeJob({ mode: "none" });
    expect(resolveDeliveryStatus({ job, delivered: true })).toBe("delivered");
  });

  // mode="announce" tests
  it('returns "delivered" when delivery.mode is "announce" and delivered is true', () => {
    const job = makeJob({ mode: "announce" });
    expect(resolveDeliveryStatus({ job, delivered: true })).toBe("delivered");
  });

  it('returns "not-delivered" when delivery.mode is "announce" and delivered is false', () => {
    const job = makeJob({ mode: "announce" });
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-delivered");
  });

  it('returns "unknown" when delivery.mode is "announce" and delivered is undefined', () => {
    const job = makeJob({ mode: "announce" });
    expect(resolveDeliveryStatus({ job })).toBe("unknown");
  });

  // mode="webhook" tests - critical fix: webhook should return not-delivered, not not-requested
  it('returns "delivered" when delivery.mode is "webhook" and delivered is true', () => {
    const job = makeJob({ mode: "webhook" });
    expect(resolveDeliveryStatus({ job, delivered: true })).toBe("delivered");
  });

  it('returns "not-delivered" when delivery.mode is "webhook" and delivered is false', () => {
    const job = makeJob({ mode: "webhook" });
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-delivered");
  });

  it('returns "unknown" when delivery.mode is "webhook" and delivered is undefined', () => {
    const job = makeJob({ mode: "webhook" });
    expect(resolveDeliveryStatus({ job })).toBe("unknown");
  });

  // Edge case tests
  it("handles legacy deliver=true field", () => {
    const job = {
      ...makeJob(),
      payload: { kind: "agentTurn", message: "hello", deliver: true },
    } as CronJob;
    // legacy deliver=true should be treated as announce mode
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-delivered");
  });

  it("handles legacy deliver=false field", () => {
    const job = {
      ...makeJob(),
      payload: { kind: "agentTurn", message: "hello", deliver: false },
    } as CronJob;
    // legacy deliver=false should be treated as none mode
    expect(resolveDeliveryStatus({ job, delivered: false })).toBe("not-requested");
  });
});
