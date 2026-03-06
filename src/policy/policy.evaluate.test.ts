import { describe, expect, it } from "vitest";
import {
  evaluateConfigMutation,
  evaluateSkillInstall,
  evaluateToolCall,
} from "./policy.evaluate.js";
import type { PolicyManagerState } from "./policy.manager.js";
import type { SignedPolicy } from "./policy.schema.js";

function buildState(policy: SignedPolicy): PolicyManagerState {
  return {
    enabled: true,
    valid: true,
    lockdown: false,
    failClosed: true,
    policyPath: "/tmp/POLICY.json",
    sigPath: "/tmp/POLICY.sig",
    statePath: "/tmp/POLICY.state.json",
    publicKey: "public",
    publicKeys: {},
    strictFilePermissions: false,
    enforceMonotonicSerial: true,
    policy,
  };
}

describe("policy evaluate", () => {
  it("denies dangerous tools by default when enabled", () => {
    const state = buildState({ version: 1 });
    const decision = evaluateToolCall("exec", { cmd: "whoami" }, { state });
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("not allowlisted");
  });

  it("denies skill installs by default when enabled", () => {
    const state = buildState({ version: 1 });
    const decision = evaluateSkillInstall(
      { skillId: "demo-skill", source: "node:@scope/demo", installId: "node-0", kind: "node" },
      { state },
    );
    expect(decision.allow).toBe(false);
  });

  it("denies config mutation by default when enabled", () => {
    const state = buildState({ version: 1 });
    const decision = evaluateConfigMutation("config.patch", undefined, { state });
    expect(decision.allow).toBe(false);
  });

  it("requires approval for explicit policy-disable mutation rules", () => {
    const state = buildState({
      version: 1,
      configMutations: {
        allow: [{ action: "config.patch", allowPolicyDisable: true, requireApproval: true }],
      },
    });
    const decision = evaluateConfigMutation(
      "config.patch",
      {
        rawPatch: { policy: { enabled: false } },
        changedPaths: ["policy.enabled"],
      },
      { state },
    );
    expect(decision.allow).toBe(true);
    expect(decision.requireApproval).toBe(true);
  });

  it("maps gateway restart action to config mutation guardrails", () => {
    const state = buildState({
      version: 1,
      tools: {
        allow: ["gateway"],
      },
      configMutations: {
        allow: [{ action: "gateway.restart" }],
      },
    });
    const decision = evaluateToolCall("gateway", { action: "restart" }, { state });
    expect(decision.allow).toBe(true);
  });

  it("maps gateway config.patch action to config mutation guardrails", () => {
    const state = buildState({
      version: 1,
      tools: {
        allow: ["gateway"],
      },
      configMutations: {
        allow: [{ action: "config.patch" }],
      },
    });
    const decision = evaluateToolCall("gateway", { action: "config.patch" }, { state });
    expect(decision.allow).toBe(true);
  });

  it("maps gateway config.apply action to config mutation guardrails", () => {
    const state = buildState({
      version: 1,
      tools: {
        allow: ["gateway"],
      },
      configMutations: {
        allow: [{ action: "config.apply" }],
      },
    });
    const decision = evaluateToolCall("gateway", { action: "config.apply" }, { state });
    expect(decision.allow).toBe(true);
  });

  it("maps gateway update.run action to config mutation guardrails", () => {
    const state = buildState({
      version: 1,
      tools: {
        allow: ["gateway"],
      },
      configMutations: {
        allow: [{ action: "update.run" }],
      },
    });
    const decision = evaluateToolCall("gateway", { action: "update.run" }, { state });
    expect(decision.allow).toBe(true);
  });

  it("normalizes mixed-case/whitespace gateway action forms before allowlist checks", () => {
    const state = buildState({
      version: 1,
      tools: {
        allow: ["gateway"],
      },
      configMutations: {
        allow: [{ action: "config.patch" }],
      },
    });
    const decision = evaluateToolCall("  GATEWAY ", { action: "  Config.Patch  " }, { state });
    expect(decision.allow).toBe(true);
  });

  it("blocks config.set when current policy is enabled and next config drops policy", () => {
    const state = buildState({
      version: 1,
      configMutations: {
        allow: [{ action: "config.set" }],
      },
    });
    const decision = evaluateConfigMutation(
      "config.set",
      {
        currentConfig: { policy: { enabled: true } },
        nextConfig: {},
        changedPaths: ["policy"],
      },
      { state },
    );
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("allowPolicyDisable");
  });
});
