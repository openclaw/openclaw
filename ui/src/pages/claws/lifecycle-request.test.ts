import { describe, expect, it } from "vitest";
import type { ClawLifecyclePlanResult } from "../../../../packages/gateway-protocol/src/index.js";
import { buildClawApplyRequest } from "./lifecycle-request.ts";

const plan: ClawLifecyclePlanResult = {
  schemaVersion: "openclaw.clawsGatewayPlan.v1",
  operation: "update",
  planIntegrity: "sha256:exact-preview-token",
  target: { agentId: "analyst" },
  actions: [],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: true,
};

describe("buildClawApplyRequest", () => {
  it("submits the exact preview token and selected immutable release", () => {
    expect(
      buildClawApplyRequest({
        pending: {
          operation: "update",
          target: "analyst",
          source: { packageName: "financial-analyst", version: "1.2.0" },
        },
        plan,
        removeUnused: false,
        riskAcknowledged: true,
      }),
    ).toEqual({
      method: "claws.update.apply",
      request: {
        target: "analyst",
        source: { packageName: "financial-analyst", version: "1.2.0" },
        planIntegrity: "sha256:exact-preview-token",
        acknowledgeClawHubRisk: true,
      },
    });
  });

  it("does not construct a mutation request before required consent", () => {
    expect(
      buildClawApplyRequest({
        pending: { operation: "update", target: "analyst" },
        plan,
        removeUnused: false,
        riskAcknowledged: false,
      }),
    ).toBeNull();
  });

  it("does not construct a request for a blocked or mismatched preview", () => {
    expect(
      buildClawApplyRequest({
        pending: { operation: "remove", target: "analyst" },
        plan,
        removeUnused: true,
        riskAcknowledged: true,
      }),
    ).toBeNull();
    expect(
      buildClawApplyRequest({
        pending: { operation: "update", target: "analyst" },
        plan: {
          ...plan,
          blockers: [{ code: "changed", path: "$", message: "Preview again." }],
        },
        removeUnused: false,
        riskAcknowledged: true,
      }),
    ).toBeNull();
  });
});
