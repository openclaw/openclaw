import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isProxyCircuitOpen,
  isProxyConnectError,
  recordProxyFailure,
  recordProxySuccess,
  resetProxyCircuits,
} from "./proxy-probe.js";

afterEach(() => {
  resetProxyCircuits();
  vi.restoreAllMocks();
});

describe("proxy circuit breaker", () => {
  const proxy = "http://proxy.test:8080";

  it("starts with circuit closed (proxy usable)", () => {
    expect(isProxyCircuitOpen(proxy)).toBe(false);
  });

  it("opens circuit after failure", () => {
    recordProxyFailure(proxy);
    expect(isProxyCircuitOpen(proxy)).toBe(true);
  });

  it("closes circuit after success", () => {
    recordProxyFailure(proxy);
    expect(isProxyCircuitOpen(proxy)).toBe(true);
    recordProxySuccess(proxy);
    expect(isProxyCircuitOpen(proxy)).toBe(false);
  });

  it("re-probes after cooldown expires", () => {
    vi.useFakeTimers();
    recordProxyFailure(proxy);
    expect(isProxyCircuitOpen(proxy)).toBe(true);

    // Advance past the initial cooldown (10s)
    vi.advanceTimersByTime(11_000);
    expect(isProxyCircuitOpen(proxy)).toBe(false); // half_open: allows probe

    vi.useRealTimers();
  });

  it("increases cooldown with consecutive failures", () => {
    vi.useFakeTimers();

    // First failure: 10s cooldown
    recordProxyFailure(proxy);
    vi.advanceTimersByTime(11_000);
    expect(isProxyCircuitOpen(proxy)).toBe(false); // half_open

    // Second failure: 20s cooldown (10s * 2^1 = 20s)
    recordProxyFailure(proxy);
    vi.advanceTimersByTime(11_000);
    expect(isProxyCircuitOpen(proxy)).toBe(true); // still in cooldown
    vi.advanceTimersByTime(10_000);
    expect(isProxyCircuitOpen(proxy)).toBe(false); // 21s > 20s cooldown

    vi.useRealTimers();
  });

  it("caps cooldown at 5 minutes", () => {
    vi.useFakeTimers();

    // Simulate many failures
    for (let i = 0; i < 20; i++) {
      recordProxyFailure(proxy);
    }

    // Should not exceed 5 minutes
    vi.advanceTimersByTime(5 * 60_000 + 1000);
    expect(isProxyCircuitOpen(proxy)).toBe(false);

    vi.useRealTimers();
  });

  it("resets cooldown after success", () => {
    vi.useFakeTimers();

    // Build up consecutive failures for a long cooldown
    for (let i = 0; i < 5; i++) {
      recordProxyFailure(proxy);
    }

    // Success resets everything
    recordProxySuccess(proxy);
    expect(isProxyCircuitOpen(proxy)).toBe(false);

    // Next failure should use initial cooldown again
    recordProxyFailure(proxy);
    vi.advanceTimersByTime(11_000);
    expect(isProxyCircuitOpen(proxy)).toBe(false);

    vi.useRealTimers();
  });

  it("normalizes proxy URLs to same circuit", () => {
    recordProxyFailure("http://proxy.test:8080");
    expect(isProxyCircuitOpen("http://proxy.test:8080/")).toBe(true);
  });
});

describe("isProxyConnectError", () => {
  it("detects ECONNREFUSED", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    expect(isProxyConnectError(err)).toBe(true);
  });

  it("detects ETIMEDOUT", () => {
    const err = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(isProxyConnectError(err)).toBe(true);
  });

  it("detects UND_ERR_CONNECT_TIMEOUT", () => {
    const err = Object.assign(new Error("timeout"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    expect(isProxyConnectError(err)).toBe(true);
  });

  it("detects ENOTFOUND", () => {
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    expect(isProxyConnectError(err)).toBe(true);
  });

  it("detects EAI_AGAIN", () => {
    const err = Object.assign(new Error("getaddrinfo EAI_AGAIN"), { code: "EAI_AGAIN" });
    expect(isProxyConnectError(err)).toBe(true);
  });

  it("detects connection error in cause", () => {
    const cause = Object.assign(new Error("inner"), { code: "ECONNREFUSED" });
    const err = new Error("fetch failed", { cause });
    expect(isProxyConnectError(err)).toBe(true);
  });

  it("returns false for non-connection errors", () => {
    expect(isProxyConnectError(new Error("404 Not Found"))).toBe(false);
    expect(isProxyConnectError(new Error("401 Unauthorized"))).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isProxyConnectError(null)).toBe(false);
    expect(isProxyConnectError(undefined)).toBe(false);
  });

  it("returns false for non-object errors", () => {
    expect(isProxyConnectError("string error")).toBe(false);
    expect(isProxyConnectError(42)).toBe(false);
  });
});
