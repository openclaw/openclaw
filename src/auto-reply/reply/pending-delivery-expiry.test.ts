import { describe, expect, it } from "vitest";
import {
  checkPendingDeliveryExpiry,
  PENDING_FINAL_DELIVERY_MAX_ATTEMPTS,
  PENDING_FINAL_DELIVERY_TTL_MS,
} from "./get-reply.js";

describe("checkPendingDeliveryExpiry (#85743)", () => {
  it("returns expired with retry-limit when attempts exceed cap", () => {
    const now = Date.now();
    const result = checkPendingDeliveryExpiry({
      attemptCount: 11,
      createdAt: now - 12 * 3600_000, // 12h ago, within TTL
      nowMs: now,
    });
    expect(result.expired).toBe(true);
    expect(result.reason).toContain("retry-limit");
    expect(result.reason).toContain("11");
  });

  it("returns expired with expiry when created more than 24h ago", () => {
    const now = Date.now();
    const result = checkPendingDeliveryExpiry({
      attemptCount: 3, // under cap
      createdAt: now - 25 * 3600_000, // 25h ago
      nowMs: now,
    });
    expect(result.expired).toBe(true);
    expect(result.reason).toContain("expiry");
    expect(result.reason).toContain("25h");
  });

  it("returns not expired when under cap and within TTL", () => {
    const now = Date.now();
    const result = checkPendingDeliveryExpiry({
      attemptCount: 5, // under cap
      createdAt: now - 6 * 3600_000, // 6h ago, within TTL
      nowMs: now,
    });
    expect(result.expired).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it("returns not expired when createdAt is null", () => {
    const now = Date.now();
    const result = checkPendingDeliveryExpiry({
      attemptCount: 5, // under cap
      createdAt: null,
      nowMs: now,
    });
    expect(result.expired).toBe(false);
  });

  it("returns expired at exactly max attempts boundary", () => {
    const now = Date.now();
    // attemptCount > MAX, so at MAX+1 it should trigger
    const atMax = checkPendingDeliveryExpiry({
      attemptCount: PENDING_FINAL_DELIVERY_MAX_ATTEMPTS,
      createdAt: now - 1000,
      nowMs: now,
    });
    expect(atMax.expired).toBe(false); // exactly at cap is OK

    const overMax = checkPendingDeliveryExpiry({
      attemptCount: PENDING_FINAL_DELIVERY_MAX_ATTEMPTS + 1,
      createdAt: now - 1000,
      nowMs: now,
    });
    expect(overMax.expired).toBe(true);
  });
});
