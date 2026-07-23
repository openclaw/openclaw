import { describe, expect, it } from "vitest";
import { sealClawLifecyclePlan } from "./control-ui-lifecycle.js";

const projected = {
  operation: "add" as const,
  target: { agentId: "analyst", name: "financial-analyst", targetVersion: "1.0.0" },
  actions: [{ kind: "workspaceFile", id: "SOUL.md", action: "add", blocked: false }],
  capabilities: [],
  blockers: [],
  riskAcknowledgementRequired: false,
};

describe("sealClawLifecyclePlan", () => {
  it("binds the secret-safe preview token to the full canonical plan", () => {
    const first = sealClawLifecyclePlan(projected, "sha256:canonical-content-a");
    const second = sealClawLifecyclePlan(projected, "sha256:canonical-content-b");

    expect(first.planIntegrity).not.toBe(second.planIntegrity);
    expect(JSON.stringify(first)).not.toContain("canonical-content-a");
  });
});
