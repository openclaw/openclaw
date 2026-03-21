import { describe, expect, it } from "vitest";
import {
  maxAsk,
  minSecurity,
  normalizeExecAsk,
  normalizeExecHost,
  normalizeExecSecurity,
  requiresExecApproval,
} from "./exec-approvals.js";

describe("exec approvals policy helpers", () => {
  it("normalizes exec host values and rejects blanks or unknown values", () => {
    expect(normalizeExecHost(" gateway ")).toBe("gateway");
    expect(normalizeExecHost("NODE")).toBe("node");
    expect(normalizeExecHost("")).toBeNull();
    expect(normalizeExecHost("ssh")).toBeNull();
  });

  it("normalizes exec security and ask values", () => {
    expect(normalizeExecSecurity(" allowlist ")).toBe("allowlist");
    expect(normalizeExecSecurity("FULL")).toBe("full");
    expect(normalizeExecSecurity("unknown")).toBeNull();

    expect(normalizeExecAsk(" on-miss ")).toBe("on-miss");
    expect(normalizeExecAsk("LOG")).toBe("log");
    expect(normalizeExecAsk(" log ")).toBe("log");
    expect(normalizeExecAsk("ALWAYS")).toBe("always");
    expect(normalizeExecAsk("maybe")).toBeNull();
  });

  it("minSecurity returns the more restrictive value", () => {
    expect(minSecurity("deny", "full")).toBe("deny");
    expect(minSecurity("allowlist", "full")).toBe("allowlist");
    expect(minSecurity("full", "allowlist")).toBe("allowlist");
  });

  it("maxAsk returns the more aggressive ask mode", () => {
    expect(maxAsk("off", "always")).toBe("always");
    expect(maxAsk("on-miss", "off")).toBe("on-miss");
    expect(maxAsk("always", "on-miss")).toBe("always");
    expect(maxAsk("off", "log")).toBe("log");
    expect(maxAsk("log", "on-miss")).toBe("on-miss");
    expect(maxAsk("log", "log")).toBe("log");
    expect(maxAsk("log", "always")).toBe("always");
  });

  it("requiresExecApproval respects ask mode and allowlist satisfaction", () => {
    const cases = [
      {
        ask: "always" as const,
        security: "allowlist" as const,
        analysisOk: true,
        allowlistSatisfied: true,
        expected: true,
      },
      {
        ask: "off" as const,
        security: "allowlist" as const,
        analysisOk: true,
        allowlistSatisfied: false,
        expected: false,
      },
      {
        ask: "log" as const,
        security: "allowlist" as const,
        analysisOk: true,
        allowlistSatisfied: false,
        expected: false,
      },
      {
        ask: "log" as const,
        security: "allowlist" as const,
        analysisOk: false,
        allowlistSatisfied: false,
        expected: false,
      },
      {
        ask: "on-miss" as const,
        security: "allowlist" as const,
        analysisOk: true,
        allowlistSatisfied: true,
        expected: false,
      },
      {
        ask: "on-miss" as const,
        security: "allowlist" as const,
        analysisOk: false,
        allowlistSatisfied: false,
        expected: true,
      },
      {
        ask: "on-miss" as const,
        security: "full" as const,
        analysisOk: false,
        allowlistSatisfied: false,
        expected: false,
      },
    ];

    for (const testCase of cases) {
      expect(requiresExecApproval(testCase)).toBe(testCase.expected);
    }
  });
});
