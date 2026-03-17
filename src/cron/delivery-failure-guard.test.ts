import { describe, expect, it } from "vitest";
import {
  buildAutoDisableNotification,
  shouldAutoDisableOnDeliveryFailure,
} from "./delivery-failure-guard.js";
import type { CronJob } from "./types.js";

function makeJob(overrides: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "test-job",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "hello" },
    delivery: { mode: "announce", channel: "telegram", to: "123" },
    state: {},
    ...overrides,
  };
}

describe("shouldAutoDisableOnDeliveryFailure", () => {
  it("returns false when job is disabled", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        enabled: false,
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: 5,
        },
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when delivery mode is none", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        delivery: { mode: "none" },
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: 5,
        },
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when no delivery config", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        delivery: undefined,
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: 5,
        },
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when last delivery succeeded", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        state: {
          lastDeliveryStatus: "delivered",
          consecutiveErrors: 5,
        },
      }),
    );
    expect(result).toBe(false);
  });

  it("returns false when consecutive errors below threshold", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: 2, // threshold is 3
        },
      }),
    );
    expect(result).toBe(false);
  });

  it("returns true when all conditions met", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        enabled: true,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: 3,
        },
      }),
    );
    expect(result).toBe(true);
  });

  it("returns true when consecutive errors exceed threshold", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: 5,
        },
      }),
    );
    expect(result).toBe(true);
  });

  it("treats missing consecutiveErrors as 0", () => {
    const result = shouldAutoDisableOnDeliveryFailure(
      makeJob({
        state: {
          lastDeliveryStatus: "not-delivered",
          consecutiveErrors: undefined,
        },
      }),
    );
    expect(result).toBe(false);
  });
});

describe("buildAutoDisableNotification", () => {
  it("builds notification with job details", () => {
    const notification = buildAutoDisableNotification(
      makeJob({
        name: "critical-alert",
        id: "job-xyz",
        state: {
          consecutiveErrors: 3,
          lastDeliveryError: "Discord rate limit exceeded",
        },
      }),
    );

    expect(notification).toContain("critical-alert");
    expect(notification).toContain("job-xyz");
    expect(notification).toContain("Discord rate limit exceeded");
    expect(notification).toContain("3 consecutive times");
  });

  it("uses generic error when no specific error available", () => {
    const notification = buildAutoDisableNotification(
      makeJob({
        state: {
          consecutiveErrors: 3,
        },
      }),
    );

    expect(notification).toContain("unknown error");
  });

  it("falls back to lastError if lastDeliveryError not available", () => {
    const notification = buildAutoDisableNotification(
      makeJob({
        state: {
          consecutiveErrors: 3,
          lastError: "Fallback error message",
          lastDeliveryError: undefined,
        },
      }),
    );

    expect(notification).toContain("Fallback error message");
  });
});
