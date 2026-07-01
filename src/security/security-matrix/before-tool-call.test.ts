import { describe, expect, it } from "vitest";
import { createSecurityMatrixBeforeToolCallAuditEvent } from "./before-tool-call.js";

describe("createSecurityMatrixBeforeToolCallAuditEvent", () => {
  it("does not claim approval was not_required from minimal facts", () => {
    expect(
      createSecurityMatrixBeforeToolCallAuditEvent({
        toolName: "file.read",
      }),
    ).toMatchObject({
      actor: "agent",
      influencedBy: [],
      capability: "read_file",
      approvalState: "none",
      operatorPolicy: "unknown",
    });
  });

  it("preserves full before-tool-call facts", () => {
    expect(
      createSecurityMatrixBeforeToolCallAuditEvent({
        toolName: "gmail.send",
        toolSource: "plugin",
        toolOwner: "gmail",
        actor: "user",
        influencedBy: ["email"],
        approvalState: "approved",
        operatorPolicy: "allowed",
      }),
    ).toMatchObject({
      toolName: "gmail.send",
      toolSource: "plugin",
      toolOwner: "gmail",
      actor: "user",
      influencedBy: ["email"],
      approvalState: "approved",
      operatorPolicy: "allowed",
      capability: "email_send",
    });
  });

  it("blocks explicit external influence over exec", () => {
    expect(
      createSecurityMatrixBeforeToolCallAuditEvent({
        toolName: "exec",
        influencedBy: ["web_fetch"],
      }),
    ).toMatchObject({
      influencedBy: ["web_fetch"],
      capability: "exec",
      policyDecision: "block",
      decision: "block",
      matched: "policy",
    });
  });
});
