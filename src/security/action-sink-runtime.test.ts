import { afterEach, describe, expect, it } from "vitest";
import type { PolicyModule } from "./action-sink-policy.js";
import { policyResult } from "./action-sink-policy.js";
import {
  __testing,
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
});
