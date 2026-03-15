import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateHttpApprovalPolicy, resolveHttpApprovalPolicy } from "./http-approval-policy.js";

function makeConfig(httpPolicy?: Record<string, unknown>): OpenClawConfig {
  return { approvals: { httpPolicy } } as unknown as OpenClawConfig;
}

describe("resolveHttpApprovalPolicy", () => {
  it("returns permissive defaults when no config", () => {
    const policy = resolveHttpApprovalPolicy({ cfg: {} as OpenClawConfig });
    expect(policy.security).toBe("full");
    expect(policy.ask).toBe("off");
    expect(policy.askFallback).toBe("full");
    expect(policy.allowlist).toEqual([]);
  });

  it("reads global config values", () => {
    const policy = resolveHttpApprovalPolicy({
      cfg: makeConfig({ security: "allowlist", ask: "on-miss", askFallback: "deny" }),
    });
    expect(policy.security).toBe("allowlist");
    expect(policy.ask).toBe("on-miss");
    expect(policy.askFallback).toBe("deny");
  });

  it("merges global allowlist", () => {
    const policy = resolveHttpApprovalPolicy({
      cfg: makeConfig({
        allowlist: [{ pattern: "https://example.com/**" }],
      }),
    });
    expect(policy.allowlist).toHaveLength(1);
    expect(policy.allowlist[0].pattern).toBe("https://example.com/**");
  });

  it("applies per-agent overrides", () => {
    const policy = resolveHttpApprovalPolicy({
      cfg: makeConfig({
        security: "full",
        agents: {
          ops: { security: "allowlist", ask: "always" },
        },
      }),
      agentId: "ops",
    });
    expect(policy.security).toBe("allowlist");
    expect(policy.ask).toBe("always");
  });

  it("applies wildcard agent overrides", () => {
    const policy = resolveHttpApprovalPolicy({
      cfg: makeConfig({
        agents: {
          "*": { security: "allowlist" },
        },
      }),
      agentId: "any-agent",
    });
    expect(policy.security).toBe("allowlist");
  });

  it("per-agent config takes priority over wildcard", () => {
    const policy = resolveHttpApprovalPolicy({
      cfg: makeConfig({
        agents: {
          "*": { security: "deny" },
          main: { security: "allowlist" },
        },
      }),
      agentId: "main",
    });
    expect(policy.security).toBe("allowlist");
  });
});

describe("evaluateHttpApprovalPolicy", () => {
  it("denies when security=deny", () => {
    const result = evaluateHttpApprovalPolicy({
      url: "https://example.com",
      policy: { security: "deny", ask: "off", askFallback: "deny", allowlist: [] },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("allows when security=full and ask=off", () => {
    const result = evaluateHttpApprovalPolicy({
      url: "https://example.com",
      policy: { security: "full", ask: "off", askFallback: "full", allowlist: [] },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("allows when allowlist matches", () => {
    const result = evaluateHttpApprovalPolicy({
      url: "https://api.example.com/v1/data",
      policy: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        allowlist: [{ pattern: "https://api.example.com/**" }],
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("denies on allowlist miss when ask=off", () => {
    const result = evaluateHttpApprovalPolicy({
      url: "https://blocked.example.com/data",
      policy: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        allowlist: [{ pattern: "https://allowed.example.com/**" }],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval on allowlist miss when ask=on-miss", () => {
    const result = evaluateHttpApprovalPolicy({
      url: "https://new-site.example.com/data",
      policy: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        allowlist: [{ pattern: "https://allowed.example.com/**" }],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("requires approval when ask=always even on match", () => {
    const result = evaluateHttpApprovalPolicy({
      url: "https://allowed.example.com/data",
      policy: {
        security: "allowlist",
        ask: "always",
        askFallback: "deny",
        allowlist: [{ pattern: "https://allowed.example.com/**" }],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });
});
