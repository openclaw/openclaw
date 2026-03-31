import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  consumeGatewayTokenExpiryWarning,
  getGatewayTokenIssuedAtMs,
  isGatewayTokenPastExpiry,
  resetGatewayTokenIssuedAt,
  setGatewayTokenIssuedAtNow,
} from "./token-expiry-state.js";

describe("token-expiry-state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    resetGatewayTokenIssuedAt();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetGatewayTokenIssuedAt();
  });

  it("tracks a single issue time", () => {
    expect(getGatewayTokenIssuedAtMs()).toBeUndefined();
    setGatewayTokenIssuedAtNow();
    expect(getGatewayTokenIssuedAtMs()).toBe(Date.now());
  });

  it("reports past expiry when age meets threshold", () => {
    setGatewayTokenIssuedAtNow();
    vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
    expect(isGatewayTokenPastExpiry({ expiryHours: 24 })).toBe(true);
  });

  it("reports not past expiry when under threshold", () => {
    setGatewayTokenIssuedAtNow();
    vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
    expect(isGatewayTokenPastExpiry({ expiryHours: 24 })).toBe(false);
  });

  it("is false when no issue time was set", () => {
    expect(isGatewayTokenPastExpiry({ expiryHours: 1 })).toBe(false);
  });

  it("consumeGatewayTokenExpiryWarning returns true only once until token is re-issued", () => {
    setGatewayTokenIssuedAtNow();
    vi.setSystemTime(new Date("2026-01-02T01:00:00.000Z"));
    expect(consumeGatewayTokenExpiryWarning({ expiryHours: 24 })).toBe(true);
    expect(consumeGatewayTokenExpiryWarning({ expiryHours: 24 })).toBe(false);
    setGatewayTokenIssuedAtNow();
    vi.setSystemTime(new Date("2026-01-03T02:00:00.000Z"));
    expect(consumeGatewayTokenExpiryWarning({ expiryHours: 24 })).toBe(true);
  });
});
