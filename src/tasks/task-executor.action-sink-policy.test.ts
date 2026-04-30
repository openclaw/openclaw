import { afterEach, describe, expect, it } from "vitest";
import { policyResult, type PolicyModule } from "../security/action-sink-policy.js";
import { __testing } from "../security/action-sink-runtime.js";
import { createQueuedTaskRun } from "./task-executor.js";

const blockStatusTransitionModule: PolicyModule = {
  id: "test-status-block",
  evaluate(request) {
    if (request.actionType !== "status_transition") {
      return undefined;
    }
    return policyResult({
      policyId: "test-status-block",
      decision: "block",
      reasonCode: "invalid_request",
      reason: "status transition blocked",
    });
  },
};

describe("task executor action-sink policy", () => {
  afterEach(() => {
    __testing.setActionSinkEnforcementOverride(null);
  });

  it("gates task status transitions before registry mutation", () => {
    __testing.setActionSinkEnforcementOverride({ modules: [blockStatusTransitionModule] });

    expect(() =>
      createQueuedTaskRun({
        runtime: "subagent",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "blocked transition",
        notifyPolicy: "done_only",
        deliveryStatus: "pending",
      }),
    ).toThrow("status transition blocked");
  });
});
