import { describe, expect, it } from "vitest";
import {
  classifyPendingFinalDeliveryBound,
  PENDING_FINAL_DELIVERY_MAX_HEARTBEAT_ATTEMPTS,
  PENDING_FINAL_DELIVERY_TTL_MS,
} from "./get-reply.js";

describe("classifyPendingFinalDeliveryBound", () => {
  const FRESH_NOW = 1_700_000_000_000;
  const freshCreatedAt = FRESH_NOW - 60_000;

  it("returns null when attemptCount is below the limit and createdAt is fresh", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 0,
        createdAt: freshCreatedAt,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: PENDING_FINAL_DELIVERY_MAX_HEARTBEAT_ATTEMPTS - 1,
        createdAt: freshCreatedAt,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
  });

  it("returns retry-limit when attemptCount reaches the configured max", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: PENDING_FINAL_DELIVERY_MAX_HEARTBEAT_ATTEMPTS,
        createdAt: freshCreatedAt,
        nowMs: FRESH_NOW,
      }),
    ).toBe("retry-limit");
  });

  it("returns retry-limit for the production case observed in #85743 (attempts=189)", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 189,
        createdAt: FRESH_NOW - 4 * 24 * 60 * 60 * 1000,
        nowMs: FRESH_NOW,
      }),
    ).toBe("retry-limit");
  });

  it("returns expiry when createdAt is older than TTL and attempt count is still small", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 1,
        createdAt: FRESH_NOW - PENDING_FINAL_DELIVERY_TTL_MS - 1,
        nowMs: FRESH_NOW,
      }),
    ).toBe("expiry");
  });

  it("returns null when createdAt age equals the TTL boundary (strict greater-than)", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 0,
        createdAt: FRESH_NOW - PENDING_FINAL_DELIVERY_TTL_MS,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
  });

  it("returns null when createdAt is undefined and attempt count is still under the limit", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 3,
        createdAt: undefined,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
  });

  it("returns null when createdAt is non-finite (treats it as unknown age)", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 1,
        createdAt: Number.NaN,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 1,
        createdAt: Number.POSITIVE_INFINITY,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
  });

  it("treats attemptCount undefined as zero", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: undefined,
        createdAt: freshCreatedAt,
        nowMs: FRESH_NOW,
      }),
    ).toBeNull();
  });

  it("retry-limit wins over expiry when both bounds are exceeded", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: PENDING_FINAL_DELIVERY_MAX_HEARTBEAT_ATTEMPTS + 5,
        createdAt: FRESH_NOW - PENDING_FINAL_DELIVERY_TTL_MS - 1,
        nowMs: FRESH_NOW,
      }),
    ).toBe("retry-limit");
  });

  it("honors caller-supplied maxAttempts and ttlMs overrides", () => {
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 3,
        createdAt: freshCreatedAt,
        nowMs: FRESH_NOW,
        maxAttempts: 3,
      }),
    ).toBe("retry-limit");
    expect(
      classifyPendingFinalDeliveryBound({
        attemptCount: 0,
        createdAt: FRESH_NOW - 2,
        nowMs: FRESH_NOW,
        ttlMs: 1,
      }),
    ).toBe("expiry");
  });
});
