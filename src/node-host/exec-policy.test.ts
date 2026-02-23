import { describe, expect, it } from "vitest";
import {
  evaluateSystemRunPolicy,
  formatSystemRunAllowlistMissMessage,
  resolveExecApprovalDecision,
} from "./exec-policy.js";

describe("resolveExecApprovalDecision", () => {
  it("accepts known approval decisions", () => {
    expect(resolveExecApprovalDecision("allow-once")).toBe("allow-once");
    expect(resolveExecApprovalDecision("allow-always")).toBe("allow-always");
  });

  it("normalizes unknown approval decisions to null", () => {
    expect(resolveExecApprovalDecision("deny")).toBeNull();
    expect(resolveExecApprovalDecision(undefined)).toBeNull();
  });
});

describe("formatSystemRunAllowlistMissMessage", () => {
  it("returns legacy allowlist miss message by default", () => {
    expect(formatSystemRunAllowlistMissMessage()).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("adds shell-wrapper guidance when wrappers are blocked", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        shellWrapperBlocked: true,
      }),
    ).toContain("shell wrappers like sh/bash/zsh -c require approval");
  });

  it("adds Windows shell-wrapper guidance when blocked by cmd.exe policy", () => {
    expect(
      formatSystemRunAllowlistMissMessage({
        shellWrapperBlocked: true,
        windowsShellWrapperBlocked: true,
      }),
    ).toContain("Windows shell wrappers like cmd.exe /c require approval");
  });
});

describe("evaluateSystemRunPolicy", () => {
  it("denies when security mode is deny", () => {
    const decision = evaluateSystemRunPolicy({
      security: "deny",
      ask: "off",
      analysisOk: true,
      allowlistSatisfied: true,
      approvalDecision: null,
      approved: false,
      isWindows: false,
      cmdInvocation: false,
      shellWrapperInvocation: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected denied decision");
    }
    expect(decision.eventReason).toBe("security=deny");
    expect(decision.errorMessage).toBe("SYSTEM_RUN_DISABLED: security=deny");
  });

  it("requires approval when ask policy requires it", () => {
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "always",
      analysisOk: true,
      allowlistSatisfied: true,
      approvalDecision: null,
      approved: false,
      isWindows: false,
      cmdInvocation: false,
      shellWrapperInvocation: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected denied decision");
    }
    expect(decision.eventReason).toBe("approval-required");
    expect(decision.requiresAsk).toBe(true);
  });

  it("allows allowlist miss when explicit approval is provided", () => {
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "on-miss",
      analysisOk: false,
      allowlistSatisfied: false,
      approvalDecision: "allow-once",
      approved: false,
      isWindows: false,
      cmdInvocation: false,
      shellWrapperInvocation: false,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error("expected allowed decision");
    }
    expect(decision.approvedByAsk).toBe(true);
  });

  it("denies allowlist misses without approval", () => {
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: false,
      allowlistSatisfied: false,
      approvalDecision: null,
      approved: false,
      isWindows: false,
      cmdInvocation: false,
      shellWrapperInvocation: false,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected denied decision");
    }
    expect(decision.eventReason).toBe("allowlist-miss");
    expect(decision.errorMessage).toBe("SYSTEM_RUN_DENIED: allowlist miss");
  });

  it("treats shell wrappers as allowlist misses", () => {
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: true,
      allowlistSatisfied: true,
      approvalDecision: null,
      approved: false,
      isWindows: false,
      cmdInvocation: false,
      shellWrapperInvocation: true,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected denied decision");
    }
    expect(decision.shellWrapperBlocked).toBe(true);
    expect(decision.errorMessage).toContain("shell wrappers like sh/bash/zsh -c");
  });

  it("keeps Windows-specific guidance for cmd.exe wrappers", () => {
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "off",
      analysisOk: true,
      allowlistSatisfied: true,
      approvalDecision: null,
      approved: false,
      isWindows: true,
      cmdInvocation: true,
      shellWrapperInvocation: true,
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed) {
      throw new Error("expected denied decision");
    }
    expect(decision.shellWrapperBlocked).toBe(true);
    expect(decision.windowsShellWrapperBlocked).toBe(true);
    expect(decision.errorMessage).toContain("Windows shell wrappers like cmd.exe /c");
  });

  it("allows execution when policy checks pass", () => {
    const decision = evaluateSystemRunPolicy({
      security: "allowlist",
      ask: "on-miss",
      analysisOk: true,
      allowlistSatisfied: true,
      approvalDecision: null,
      approved: false,
      isWindows: false,
      cmdInvocation: false,
      shellWrapperInvocation: false,
    });
    expect(decision.allowed).toBe(true);
    if (!decision.allowed) {
      throw new Error("expected allowed decision");
    }
    expect(decision.requiresAsk).toBe(false);
    expect(decision.analysisOk).toBe(true);
    expect(decision.allowlistSatisfied).toBe(true);
  });
});
