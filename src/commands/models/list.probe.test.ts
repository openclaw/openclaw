import { describe, expect, it } from "vitest";
import {
  formatRateLimitShort,
  mapFailoverReasonToProbeStatus,
  parseIntHeader,
  parseRateLimitHeaders,
} from "./list.probe.js";

describe("mapFailoverReasonToProbeStatus", () => {
  it("maps auth_permanent to auth", () => {
    expect(mapFailoverReasonToProbeStatus("auth_permanent")).toBe("auth");
  });

  it("keeps existing failover reason mappings", () => {
    expect(mapFailoverReasonToProbeStatus("auth")).toBe("auth");
    expect(mapFailoverReasonToProbeStatus("rate_limit")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("overloaded")).toBe("rate_limit");
    expect(mapFailoverReasonToProbeStatus("billing")).toBe("billing");
    expect(mapFailoverReasonToProbeStatus("timeout")).toBe("timeout");
    expect(mapFailoverReasonToProbeStatus("format")).toBe("format");
  });

  it("falls back to unknown for unrecognized values", () => {
    expect(mapFailoverReasonToProbeStatus(undefined)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus(null)).toBe("unknown");
    expect(mapFailoverReasonToProbeStatus("model_not_found")).toBe("unknown");
  });
});

describe("parseIntHeader", () => {
  it("parses valid integer strings", () => {
    expect(parseIntHeader("42")).toBe(42);
    expect(parseIntHeader("0")).toBe(0);
    expect(parseIntHeader("1000000")).toBe(1_000_000);
  });

  it("returns undefined for null, undefined, or empty string", () => {
    expect(parseIntHeader(null)).toBeUndefined();
    expect(parseIntHeader(undefined)).toBeUndefined();
    expect(parseIntHeader("")).toBeUndefined();
  });

  it("returns undefined for non-numeric strings", () => {
    expect(parseIntHeader("abc")).toBeUndefined();
    expect(parseIntHeader("NaN")).toBeUndefined();
    expect(parseIntHeader("Infinity")).toBeUndefined();
  });

  it("truncates floating-point strings to integer", () => {
    expect(parseIntHeader("42.9")).toBe(42);
  });
});

describe("parseRateLimitHeaders", () => {
  function mockHeaders(map: Record<string, string>): { get(name: string): string | null } {
    return {
      get(name: string) {
        return map[name] ?? null;
      },
    };
  }

  it("extracts all standard rate-limit headers", () => {
    const result = parseRateLimitHeaders(
      mockHeaders({
        "x-ratelimit-remaining-requests": "945",
        "x-ratelimit-limit-requests": "1000",
        "x-ratelimit-remaining-tokens": "78000",
        "x-ratelimit-limit-tokens": "80000",
        "x-ratelimit-reset-requests": "2026-03-10T18:00:00Z",
        "x-ratelimit-reset-tokens": "2026-03-10T18:00:00Z",
      }),
    );
    expect(result).toEqual({
      remainingRequests: 945,
      limitRequests: 1000,
      remainingTokens: 78000,
      limitTokens: 80000,
      resetRequests: "2026-03-10T18:00:00Z",
      resetTokens: "2026-03-10T18:00:00Z",
    });
  });

  it("returns undefined when no rate-limit headers are present", () => {
    expect(parseRateLimitHeaders(mockHeaders({}))).toBeUndefined();
  });

  it("handles partial headers gracefully", () => {
    const result = parseRateLimitHeaders(
      mockHeaders({
        "x-ratelimit-remaining-requests": "10",
        "x-ratelimit-limit-requests": "100",
      }),
    );
    expect(result).toEqual({
      remainingRequests: 10,
      limitRequests: 100,
      remainingTokens: undefined,
      limitTokens: undefined,
      resetRequests: undefined,
      resetTokens: undefined,
    });
  });

  it("handles only token headers", () => {
    const result = parseRateLimitHeaders(
      mockHeaders({
        "x-ratelimit-remaining-tokens": "500000",
        "x-ratelimit-limit-tokens": "1000000",
      }),
    );
    expect(result).toBeDefined();
    expect(result?.remainingTokens).toBe(500000);
    expect(result?.limitTokens).toBe(1000000);
    expect(result?.remainingRequests).toBeUndefined();
  });

  it("handles non-numeric header values gracefully", () => {
    const result = parseRateLimitHeaders(
      mockHeaders({
        "x-ratelimit-remaining-requests": "not-a-number",
        "x-ratelimit-reset-requests": "1m30s",
      }),
    );
    expect(result).toBeDefined();
    expect(result?.remainingRequests).toBeUndefined();
    expect(result?.resetRequests).toBe("1m30s");
  });
});

describe("formatRateLimitShort", () => {
  it("returns dashes for undefined/null input", () => {
    expect(formatRateLimitShort(undefined)).toEqual({ rpm: "-", tpm: "-" });
    expect(formatRateLimitShort(null)).toEqual({ rpm: "-", tpm: "-" });
  });

  it("formats remaining/limit pairs", () => {
    expect(
      formatRateLimitShort({
        remainingRequests: 945,
        limitRequests: 1000,
        remainingTokens: 78000,
        limitTokens: 80000,
      }),
    ).toEqual({ rpm: "945/1000", tpm: "78000/80000" });
  });

  it("formats remaining-only values", () => {
    expect(
      formatRateLimitShort({
        remainingRequests: 500,
        remainingTokens: 10000,
      }),
    ).toEqual({ rpm: "500", tpm: "10000" });
  });

  it("formats limit-only values", () => {
    expect(
      formatRateLimitShort({
        limitRequests: 1000,
        limitTokens: 80000,
      }),
    ).toEqual({ rpm: "-/1000", tpm: "-/80000" });
  });

  it("returns dashes for empty info object", () => {
    expect(formatRateLimitShort({})).toEqual({ rpm: "-", tpm: "-" });
  });
});
