/** Tests node-host exec policy evaluation and approval decisions. */
import { describe, expect, it } from "vitest";
import { evaluateSystemRunPolicy, resolveExecApprovalDecision } from "./exec-policy.js";

type EvaluatePolicyParams = Parameters<typeof evaluateSystemRunPolicy>[0];
type EvaluatePolicyDecision = ReturnType<typeof evaluateSystemRunPolicy>;

const buildPolicyParams = (overrides: Partial<EvaluatePolicyParams>): EvaluatePolicyParams => {
  return {
    security: "allowlist",
    ask: "off",
    analysisOk: true,
    allowlistSatisfied: true,
    approvalDecision: null,
    approved: false,
    isWindows: false,
    cmdInvocation: false,
    shellWrapperInvocation: false,
    ...overrides,
  };
};

const expectDeniedDecision = (decision: EvaluatePolicyDecision) => {
  expect(decision.allowed).toBe(false);
  if (decision.allowed) {
    throw new Error("expected denied decision");
  }
  return decision;
};

const expectAllowedDecision = (decision: EvaluatePolicyDecision) => {
  expect(decision.allowed).toBe(true);
  if (!decision.allowed) {
    throw new Error("expected allowed decision");
  }
  return decision;
};

describe("resolveExecApprovalDecision", () => {
  it("normalizes unknown approval decisions to null", () => {
    expect(resolveExecApprovalDecision("deny")).toBeNull();
    expect(resolveExecApprovalDecision(undefined)).toBeNull();
  });
});

describe("evaluateSystemRunPolicy", () => {
  it("denies when security mode is deny", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(buildPolicyParams({ security: "deny" })),
    );
    expect(denied.eventReason).toBe("security=deny");
    expect(denied.errorMessage).toBe("SYSTEM_RUN_DISABLED: security=deny");
  });

  it("still requires approval when ask=always even with durable trust", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({
          security: "full",
          ask: "always",
          durableApprovalSatisfied: true,
        }),
      ),
    );
    expect(denied.eventReason).toBe("approval-required");
    expect(denied.requiresAsk).toBe(true);
  });

  it("allows allowlist miss when explicit approval is provided", () => {
    const allowed = expectAllowedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({
          ask: "on-miss",
          analysisOk: false,
          allowlistSatisfied: false,
          approvalDecision: "allow-once",
        }),
      ),
    );
    expect(allowed.approvedByAsk).toBe(true);
  });

  it("keeps Windows-specific guidance for cmd.exe wrappers", () => {
    const denied = expectDeniedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({ isWindows: true, cmdInvocation: true, shellWrapperInvocation: true }),
      ),
    );
    expect(denied.shellWrapperBlocked).toBe(true);
    expect(denied.windowsShellWrapperBlocked).toBe(true);
    expect(denied.errorMessage).toContain("Windows shell wrappers like cmd.exe /c");
  });

  it("does not block Windows cmd.exe invocations without inline shell-wrapper transport", () => {
    const allowed = expectAllowedDecision(
      evaluateSystemRunPolicy(
        buildPolicyParams({ isWindows: true, cmdInvocation: true, shellWrapperInvocation: false }),
      ),
    );
    expect(allowed.shellWrapperBlocked).toBe(false);
    expect(allowed.windowsShellWrapperBlocked).toBe(false);
  });
});
