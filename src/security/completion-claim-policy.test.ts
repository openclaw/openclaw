import { describe, expect, it } from "vitest";
import {
  containsCompletionClaim,
  createEvidenceGatePolicyModule,
} from "./completion-claim-policy.js";

describe("completion claim policy", () => {
  it("classifies completion claims", () => {
    expect(containsCompletionClaim("this is done and ready")).toBe(true);
    expect(containsCompletionClaim("working on it")).toBe(false);
  });

  it("blocks completion/status claims without evidence", () => {
    const mod = createEvidenceGatePolicyModule({
      repoRoot: process.cwd(),
      branch: "agent/forge-mch-61-action-sink-policy-20260426-1940",
    });
    expect(
      mod.evaluate(
        { policyVersion: "v1", actionType: "completion_claim", payloadSummary: "done" },
        {},
      ),
    ).toMatchObject({ decision: "block" });
    expect(
      mod.evaluate(
        { policyVersion: "v1", actionType: "status_transition", context: { status: "done" } },
        {},
      ),
    ).toMatchObject({ decision: "block" });
  });
});
