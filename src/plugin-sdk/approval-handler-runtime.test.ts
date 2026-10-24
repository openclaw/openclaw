import { describe, expect, it } from "vitest";
import type { SystemAgentApprovalRequest } from "../infra/system-agent-approvals.js";
import {
  buildChannelApprovalResolvedText,
  type ResolvedApprovalView,
} from "./approval-handler-runtime.js";
import {
  buildSystemAgentApprovalResolvedText,
  formatChannelApprovalResolvedLabel,
} from "./approval-runtime.js";

type SystemAgentView = Extract<ResolvedApprovalView, { approvalKind: "system-agent" }>;

function systemAgentView(state: Partial<SystemAgentView> = {}): SystemAgentView {
  return {
    approvalKind: "system-agent",
    approvalId: "system-agent:change",
    phase: "resolved",
    title: "OpenClaw change",
    metadata: [],
    commandText: "restart the Gateway",
    operationSummary: "restart the Gateway",
    decision: "allow-once",
    ...state,
  };
}

const applying = "✅ OpenClaw change approved. Applying: restart the Gateway";
const denied = "❌ OpenClaw change denied. No change was made.";
const applied = "✅ OpenClaw change approved and applied: restart the Gateway";
const unconfirmed =
  "⚠️ OpenClaw change approved, but completion could not be confirmed. Check the current settings before retrying.";
const cancelled =
  "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.";
const cases: Array<[Partial<SystemAgentView>, string, string]> = [
  [{}, "Allowed once", applying],
  [{ decision: "allow-always" }, "Allowed always", applying],
  [{ decision: "deny" }, "Denied", denied],
  [{ applicationStatus: "applied" }, "Applied", applied],
  [{ applicationStatus: "not-applied" }, "Completion unconfirmed", unconfirmed],
  [{ decision: "deny", applicationStatus: "not-applied" }, "Denied", denied],
  [{ decision: "deny", applicationStatus: "applied" }, "Applied", denied],
  [
    { decision: "deny", applicationStatus: "applied", terminalStatus: "cancelled" },
    "Cancelled",
    cancelled,
  ],
];

describe("approval terminal presentation", () => {
  it.each(cases)("preserves rich and prose precedence for %j", (state, label, text) => {
    const view = systemAgentView(state);
    expect(formatChannelApprovalResolvedLabel(view)).toBe(label);
    expect(buildSystemAgentApprovalResolvedText(view)).toBe(text);
  });

  it("keeps decision spelling local without overriding application results", () => {
    const label = (state: Partial<SystemAgentView> = {}) =>
      formatChannelApprovalResolvedLabel(
        systemAgentView(state),
        (decision) => `Decision: ${decision}`,
      );
    expect(label()).toBe("Decision: allow-once");
    expect(label({ applicationStatus: "not-applied" })).toBe("Completion unconfirmed");
  });

  it("uses the resolved event's decision for channel prose", () => {
    const request: SystemAgentApprovalRequest = {
      approvalKind: "system-agent",
      id: "system-agent:change",
      request: {
        title: "OpenClaw change",
        description: "restart the Gateway",
        command: "restart the Gateway",
        proposalHash: "a".repeat(64),
        allowedDecisions: ["allow-once", "deny"],
        sessionId: "test-session",
      },
      createdAtMs: 0,
      expiresAtMs: 60_000,
    };
    expect(
      buildChannelApprovalResolvedText({
        request,
        resolved: { id: request.id, decision: "deny", ts: 1 },
        view: systemAgentView({ applicationStatus: "applied" }),
      }),
    ).toBe("❌ OpenClaw change denied. No change was made.");
  });
});
