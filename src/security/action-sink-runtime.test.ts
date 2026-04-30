import { afterEach, describe, expect, it } from "vitest";
import type { PolicyModule } from "./action-sink-policy.js";
import { policyResult } from "./action-sink-policy.js";
import {
  __testing,
  evaluateConfiguredActionSinkPolicySync,
  enforceActionSinkPolicy,
  enforceActionSinkPolicySync,
} from "./action-sink-runtime.js";

const blockingModule: PolicyModule = {
  id: "test-block",
  evaluate(request) {
    return policyResult({
      policyId: "test-block",
      decision: "block",
      reasonCode: "invalid_request",
      reason: `blocked ${request.actionType}`,
      correlationId: request.correlationId,
    });
  },
};

describe("action sink runtime enforcement", () => {
  afterEach(() => {
    __testing.setActionSinkEnforcementOverride(null);
    delete process.env.OPENCLAW_ACTION_SINK_EXTERNAL_ALLOWLIST;
  });

  it("throws before async execution when policy blocks", async () => {
    __testing.setActionSinkEnforcementOverride({ modules: [blockingModule] });

    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "message_send",
        payloadSummary: "hello",
      }),
    ).rejects.toThrow("blocked message_send");
  });

  it("throws before sync execution when policy blocks", () => {
    __testing.setActionSinkEnforcementOverride({ modules: [blockingModule] });

    expect(() =>
      enforceActionSinkPolicySync({
        policyVersion: "v1",
        actionType: "status_transition",
        context: { status: "succeeded" },
      }),
    ).toThrow("blocked status_transition");
  });

  it("blocks completion claims without evidence by default", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "completion_claim",
        payloadSummary: "This is done.",
      }),
    ).rejects.toThrow("Completion/status claim requires review and QA evidence");
  });

  it("allows environment-scoped external message targets", () => {
    process.env.OPENCLAW_ACTION_SINK_EXTERNAL_ALLOWLIST = "telegram:-1003872638243|message_send";

    expect(
      evaluateConfiguredActionSinkPolicySync({
        policyVersion: "v1",
        actionType: "message_send",
        targetResource: "telegram:-1003872638243",
        payloadSummary: "ping",
      }).decision,
    ).toBe("allow");

    expect(
      evaluateConfiguredActionSinkPolicySync({
        policyVersion: "v1",
        actionType: "message_send",
        targetResource: "telegram:-1000000000000",
        payloadSummary: "ping",
      }).decision,
    ).toBe("requireApproval");
  });

  it("requires approval for external shell network commands unless exec approval is present", async () => {
    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "shell_exec",
        payloadSummary: "curl -fsS https://example.test",
        context: { command: "curl -fsS https://example.test" },
      }),
    ).rejects.toMatchObject({
      name: "ActionSinkPolicyDeniedError",
      decision: "requireApproval",
      reasonCode: "shell_risk",
    });

    await expect(
      enforceActionSinkPolicy({
        policyVersion: "v1",
        actionType: "shell_exec",
        payloadSummary: "curl -fsS https://example.test",
        context: {
          command: "curl -fsS https://example.test",
          actionSinkApproval: {
            source: "exec-approval",
            approvalId: "req-1",
          },
        },
      }),
    ).resolves.toMatchObject({ decision: "allow" });
  });
});
