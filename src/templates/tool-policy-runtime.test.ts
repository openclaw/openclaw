import { describe, expect, it } from "vitest";
import { resolveTemplateToolPolicyConsent } from "./tool-policy-runtime.js";

describe("resolveTemplateToolPolicyConsent", () => {
  it("leaves ordinary non-Template profiles dynamic", () => {
    const tools = { profile: "coding" };
    expect(
      resolveTemplateToolPolicyConsent({
        agentTools: tools,
        agentId: "worker",
        profile: "coding",
        ownsProfile: true,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });

  it("does not treat an inherited global profile as Template-owned authority", () => {
    expect(
      resolveTemplateToolPolicyConsent({
        agentId: "worker",
        profile: "coding",
        ownsProfile: false,
        hasAgentAllowlist: false,
      }),
    ).toEqual({ frozen: false });
  });
});
