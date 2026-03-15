import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { evaluateToolApprovalPolicy, resolveToolApprovalPolicy } from "./tool-approval-policy.js";

function makeConfig(toolPolicy?: Record<string, unknown>): OpenClawConfig {
  return { approvals: { toolPolicy } } as unknown as OpenClawConfig;
}

describe("resolveToolApprovalPolicy", () => {
  it("returns permissive defaults when no config", () => {
    const policy = resolveToolApprovalPolicy({ cfg: {} as OpenClawConfig });
    expect(policy.security).toBe("full");
    expect(policy.ask).toBe("off");
    expect(policy.askFallback).toBe("full");
    expect(policy.allowlist).toEqual([]);
  });

  it("reads global config values", () => {
    const policy = resolveToolApprovalPolicy({
      cfg: makeConfig({ security: "allowlist", ask: "on-miss", askFallback: "deny" }),
    });
    expect(policy.security).toBe("allowlist");
    expect(policy.ask).toBe("on-miss");
    expect(policy.askFallback).toBe("deny");
  });

  it("merges global allowlist", () => {
    const policy = resolveToolApprovalPolicy({
      cfg: makeConfig({
        allowlist: [{ pattern: "github__list_*" }],
      }),
    });
    expect(policy.allowlist).toHaveLength(1);
    expect(policy.allowlist[0].pattern).toBe("github__list_*");
  });

  it("applies per-agent overrides", () => {
    const policy = resolveToolApprovalPolicy({
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
    const policy = resolveToolApprovalPolicy({
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
    const policy = resolveToolApprovalPolicy({
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

describe("evaluateToolApprovalPolicy", () => {
  it("denies when security=deny", () => {
    const result = evaluateToolApprovalPolicy({
      toolName: "github__list_repos",
      policy: { security: "deny", ask: "off", askFallback: "deny", allowlist: [] },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("allows when security=full and ask=off", () => {
    const result = evaluateToolApprovalPolicy({
      toolName: "github__list_repos",
      policy: { security: "full", ask: "off", askFallback: "full", allowlist: [] },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("allows when allowlist matches", () => {
    const result = evaluateToolApprovalPolicy({
      toolName: "github__list_repos",
      policy: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        allowlist: [{ pattern: "github__list_*" }],
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  it("denies on allowlist miss when ask=off", () => {
    const result = evaluateToolApprovalPolicy({
      toolName: "github__delete_repos",
      policy: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        allowlist: [{ pattern: "github__list_*" }],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval on allowlist miss when ask=on-miss", () => {
    const result = evaluateToolApprovalPolicy({
      toolName: "github__delete_repos",
      policy: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
        allowlist: [{ pattern: "github__list_*" }],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });

  it("requires approval when ask=always even on match", () => {
    const result = evaluateToolApprovalPolicy({
      toolName: "github__list_repos",
      policy: {
        security: "allowlist",
        ask: "always",
        askFallback: "deny",
        allowlist: [{ pattern: "github__list_*" }],
      },
    });
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(true);
  });
});
