import { describe, expect, it } from "vitest";
import { __testing } from "./x402-payment.js";

describe("x402 permit cache key", () => {
  it("includes the account address", () => {
    const key = __testing.buildPermitCacheKey({
      network: "eip155:8453",
      asset: "0xasset",
      payTo: "0xpayto",
      cap: "1000000",
      account: "0xaccount",
    });

    expect(key).toContain("0xaccount");
  });

  it("differs for different accounts", () => {
    const base = {
      network: "eip155:8453",
      asset: "0xasset",
      payTo: "0xpayto",
      cap: "1000000",
    };

    const keyA = __testing.buildPermitCacheKey({ ...base, account: "0xaccountA" });
    const keyB = __testing.buildPermitCacheKey({ ...base, account: "0xaccountB" });

    expect(keyA).not.toEqual(keyB);
  });
});

describe("parseSawConfig", () => {
  it("parses a valid SAW sentinel", () => {
    const result = __testing.parseSawConfig("saw:main@/run/saw.sock");
    expect(result).toEqual({ walletName: "main", socketPath: "/run/saw.sock" });
  });

  it("parses a sentinel with a custom wallet and socket", () => {
    const result = __testing.parseSawConfig("saw:spending@/tmp/agent-wallet.sock");
    expect(result).toEqual({ walletName: "spending", socketPath: "/tmp/agent-wallet.sock" });
  });

  it("returns null for a private key", () => {
    const result = __testing.parseSawConfig(
      "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    );
    expect(result).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(__testing.parseSawConfig(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(__testing.parseSawConfig("")).toBeNull();
  });

  it("returns null for missing @ separator", () => {
    expect(__testing.parseSawConfig("saw:main")).toBeNull();
  });

  it("returns null for missing wallet name", () => {
    expect(__testing.parseSawConfig("saw:@/run/saw.sock")).toBeNull();
  });

  it("trims whitespace", () => {
    const result = __testing.parseSawConfig("  saw:main@/run/saw.sock  ");
    expect(result).toEqual({ walletName: "main", socketPath: "/run/saw.sock" });
  });
});

describe("parseErrorResponse", () => {
  it("extracts error code from nested error object", () => {
    const body = { error: { code: "settlement_blocked", message: "blocked" } };
    const result = __testing.parseErrorResponse(body);
    expect(result).toEqual({ code: "settlement_blocked", message: "blocked" });
  });

  it("preserves top-level code when nested error object omits it", () => {
    const body = { code: "cap_exhausted", error: { message: "cap exhausted for session" } };
    const result = __testing.parseErrorResponse(body);
    expect(result).toEqual({ code: "cap_exhausted", message: "cap exhausted for session" });
  });

  it("extracts top-level error code", () => {
    const body = { code: "cap_exhausted", error: "cap exhausted for session" };
    const result = __testing.parseErrorResponse(body);
    expect(result).toEqual({ code: "cap_exhausted", error: "cap exhausted for session" });
  });

  it("returns null for non-object input", () => {
    expect(__testing.parseErrorResponse(null)).toBeNull();
    expect(__testing.parseErrorResponse("string")).toBeNull();
    expect(__testing.parseErrorResponse(undefined)).toBeNull();
  });

  it("returns null when no error info is present", () => {
    expect(__testing.parseErrorResponse({ data: "ok" })).toBeNull();
  });

  it("handles error as a string message", () => {
    const body = { error: "session closed by facilitator" };
    const result = __testing.parseErrorResponse(body);
    expect(result).toEqual({ error: "session closed by facilitator" });
  });
});

describe("error detection helpers", () => {
  describe("isCapExhausted", () => {
    it("returns true for code='cap_exhausted'", () => {
      expect(__testing.isCapExhausted({ code: "cap_exhausted" })).toBe(true);
    });

    it("returns true for error text containing 'cap exhausted'", () => {
      expect(__testing.isCapExhausted({ error: "Payment failed: cap exhausted for session" })).toBe(
        true,
      );
    });

    it("returns false for other errors", () => {
      expect(__testing.isCapExhausted({ code: "invalid_signature" })).toBe(false);
    });

    it("returns false for empty error", () => {
      expect(__testing.isCapExhausted({})).toBe(false);
    });
  });

  describe("isSessionClosed", () => {
    it("returns true for code='session_closed'", () => {
      expect(__testing.isSessionClosed({ code: "session_closed" })).toBe(true);
    });

    it("returns true for error text containing 'session closed'", () => {
      expect(__testing.isSessionClosed({ error: "session closed by facilitator" })).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(__testing.isSessionClosed({ code: "invalid_signature" })).toBe(false);
    });
  });

  describe("isSettlementBlocked", () => {
    it("returns true for code='settlement_blocked'", () => {
      expect(__testing.isSettlementBlocked({ code: "settlement_blocked" })).toBe(true);
    });

    it("returns true for error text containing 'settlement blocked'", () => {
      expect(__testing.isSettlementBlocked({ error: "settlement blocked after failure" })).toBe(
        true,
      );
    });

    it("returns true for 'blocked after previous settlement'", () => {
      expect(__testing.isSettlementBlocked({ message: "blocked after previous settlement" })).toBe(
        true,
      );
    });

    it("returns false for other errors", () => {
      expect(__testing.isSettlementBlocked({ code: "rate_limit_exceeded" })).toBe(false);
    });
  });

  describe("isSessionPermitMismatch", () => {
    it("returns true for code='session_permit_mismatch'", () => {
      expect(__testing.isSessionPermitMismatch({ code: "session_permit_mismatch" })).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(__testing.isSessionPermitMismatch({ code: "settlement_blocked" })).toBe(false);
    });
  });

  describe("shouldInvalidatePermit", () => {
    it("returns true for cap_exhausted", () => {
      expect(__testing.shouldInvalidatePermit({ code: "cap_exhausted" })).toBe(true);
    });

    it("returns true for session_closed", () => {
      expect(__testing.shouldInvalidatePermit({ code: "session_closed" })).toBe(true);
    });

    it("returns true for settlement_blocked", () => {
      expect(__testing.shouldInvalidatePermit({ code: "settlement_blocked" })).toBe(true);
    });

    it("returns true for session_permit_mismatch", () => {
      expect(__testing.shouldInvalidatePermit({ code: "session_permit_mismatch" })).toBe(true);
    });

    it("returns false for other errors", () => {
      expect(__testing.shouldInvalidatePermit({ code: "invalid_signature" })).toBe(false);
    });

    it("returns false for network errors", () => {
      expect(__testing.shouldInvalidatePermit({ error: "Network timeout" })).toBe(false);
    });
  });
});

describe("computePermitDeadline", () => {
  it("returns now + validity when no minimum is set", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = __testing.computePermitDeadline();
    expect(result).toBeGreaterThanOrEqual(now + 3600 - 2);
    expect(result).toBeLessThanOrEqual(now + 3600 + 2);
  });

  it("returns now + validity when minimum is below computed deadline", () => {
    const now = Math.floor(Date.now() / 1000);
    const result = __testing.computePermitDeadline(now + 100);
    expect(result).toBeGreaterThanOrEqual(now + 3600 - 2);
    expect(result).toBeLessThanOrEqual(now + 3600 + 2);
  });

  it("bumps deadline to minDeadlineExclusive + 1 when computed is not greater", () => {
    const farFuture = Math.floor(Date.now() / 1000) + 999999;
    const result = __testing.computePermitDeadline(farFuture);
    expect(result).toBe(farFuture + 1);
  });
});
