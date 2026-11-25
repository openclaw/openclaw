/** Tests node-host exec policy evaluation and approval decisions. */
import { describe, expect, it } from "vitest";
import { evaluateSystemRunPolicy, resolveExecApprovalDecision } from "./exec-policy.js";

type EvaluatePolicyParams = Parameters<typeof evaluateSystemRunPolicy>[0];

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

it("normalizes unknown approval decisions to null", () => {
  expect(resolveExecApprovalDecision("deny")).toBeNull();
  expect(resolveExecApprovalDecision(undefined)).toBeNull();
});

describe("evaluateSystemRunPolicy", () => {
  it("denies when security mode is deny", () => {
    expect(evaluateSystemRunPolicy(buildPolicyParams({ security: "deny" }))).toMatchObject({
      allowed: false,
      eventReason: "security=deny",
      errorMessage: "SYSTEM_RUN_DISABLED: security=deny",
    });
  });

  it("still requires approval when ask=always even with durable trust", () => {
    expect(
      evaluateSystemRunPolicy(
        buildPolicyParams({ security: "full", ask: "always", durableApprovalSatisfied: true }),
      ),
    ).toMatchObject({ allowed: false, eventReason: "approval-required" });
  });

  it("allows allowlist miss when explicit approval is provided", () => {
    expect(
      evaluateSystemRunPolicy(
        buildPolicyParams({
          ask: "on-miss",
          analysisOk: false,
          allowlistSatisfied: false,
          approvalDecision: "allow-once",
        }),
      ),
    ).toMatchObject({ allowed: true, approvedByAsk: true });
  });

  it("keeps Windows-specific guidance for cmd.exe wrappers", () => {
    expect(
      evaluateSystemRunPolicy(
        buildPolicyParams({ isWindows: true, cmdInvocation: true, shellWrapperInvocation: true }),
      ),
    ).toMatchObject({
      allowed: false,
      shellWrapperBlocked: true,
      errorMessage: expect.stringContaining("Windows shell wrappers like cmd.exe /c"),
    });
  });

  it("does not block Windows cmd.exe invocations without inline shell-wrapper transport", () => {
    expect(
      evaluateSystemRunPolicy(
        buildPolicyParams({ isWindows: true, cmdInvocation: true, shellWrapperInvocation: false }),
      ),
    ).toMatchObject({ allowed: true, shellWrapperBlocked: false });
  });
});
