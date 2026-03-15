import { describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_ASK,
  DEFAULT_HTTP_ASK_FALLBACK,
  DEFAULT_HTTP_SECURITY,
  normalizeHttpAsk,
  normalizeHttpSecurity,
  requiresHttpApproval,
  resolveHttpApprovalAgent,
  resolveHttpApprovalDefaults,
} from "./http-approvals.js";

describe("normalizeHttpSecurity", () => {
  it("accepts valid values", () => {
    expect(normalizeHttpSecurity("deny")).toBe("deny");
    expect(normalizeHttpSecurity("allowlist")).toBe("allowlist");
    expect(normalizeHttpSecurity("full")).toBe("full");
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeHttpSecurity("  DENY  ")).toBe("deny");
    expect(normalizeHttpSecurity(" Full ")).toBe("full");
  });

  it("returns null for invalid values", () => {
    expect(normalizeHttpSecurity("invalid")).toBeNull();
    expect(normalizeHttpSecurity(null)).toBeNull();
    expect(normalizeHttpSecurity(undefined)).toBeNull();
  });
});

describe("normalizeHttpAsk", () => {
  it("accepts valid values", () => {
    expect(normalizeHttpAsk("off")).toBe("off");
    expect(normalizeHttpAsk("on-miss")).toBe("on-miss");
    expect(normalizeHttpAsk("always")).toBe("always");
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeHttpAsk("  OFF  ")).toBe("off");
    expect(normalizeHttpAsk("ALWAYS")).toBe("always");
  });

  it("returns null for invalid values", () => {
    expect(normalizeHttpAsk("invalid")).toBeNull();
    expect(normalizeHttpAsk(null)).toBeNull();
  });
});

describe("requiresHttpApproval", () => {
  it("always requires approval when ask=always", () => {
    expect(
      requiresHttpApproval({ ask: "always", security: "full", allowlistSatisfied: true }),
    ).toBe(true);
    expect(
      requiresHttpApproval({ ask: "always", security: "allowlist", allowlistSatisfied: true }),
    ).toBe(true);
  });

  it("requires approval on allowlist miss when ask=on-miss", () => {
    expect(
      requiresHttpApproval({ ask: "on-miss", security: "allowlist", allowlistSatisfied: false }),
    ).toBe(true);
  });

  it("does not require approval on allowlist hit when ask=on-miss", () => {
    expect(
      requiresHttpApproval({ ask: "on-miss", security: "allowlist", allowlistSatisfied: true }),
    ).toBe(false);
  });

  it("does not require approval when ask=off", () => {
    expect(
      requiresHttpApproval({ ask: "off", security: "allowlist", allowlistSatisfied: false }),
    ).toBe(false);
  });

  it("does not require approval for on-miss with security=full", () => {
    expect(
      requiresHttpApproval({ ask: "on-miss", security: "full", allowlistSatisfied: false }),
    ).toBe(false);
  });
});

describe("resolveHttpApprovalDefaults", () => {
  it("returns built-in defaults when no config provided", () => {
    const result = resolveHttpApprovalDefaults();
    expect(result.security).toBe(DEFAULT_HTTP_SECURITY);
    expect(result.ask).toBe(DEFAULT_HTTP_ASK);
    expect(result.askFallback).toBe(DEFAULT_HTTP_ASK_FALLBACK);
  });

  it("uses provided values over defaults", () => {
    const result = resolveHttpApprovalDefaults({
      security: "deny",
      ask: "always",
      askFallback: "deny",
    });
    expect(result.security).toBe("deny");
    expect(result.ask).toBe("always");
    expect(result.askFallback).toBe("deny");
  });
});

describe("resolveHttpApprovalAgent", () => {
  it("returns defaults when no agent config provided", () => {
    const result = resolveHttpApprovalAgent();
    expect(result.security).toBe(DEFAULT_HTTP_SECURITY);
    expect(result.allowlist).toEqual([]);
  });

  it("merges agent config with defaults", () => {
    const result = resolveHttpApprovalAgent(
      { security: "allowlist", allowlist: [{ pattern: "https://example.com/**" }] },
      resolveHttpApprovalDefaults(),
    );
    expect(result.security).toBe("allowlist");
    expect(result.allowlist).toHaveLength(1);
  });
});
