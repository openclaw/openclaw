// Covers approval request agent and session filters.
import { describe, expect, it } from "vitest";
import { matchesApprovalRequestFilters } from "./approval-request-filters.js";

describe("approval request filters", () => {
  it("matches explicit agent ids and session substrings", () => {
    expect(
      matchesApprovalRequestFilters({
        request: {
          agentId: "ops-agent",
          sessionKey: "agent:ops-agent:slack:direct:U1:tail",
        },
        agentFilter: ["ops-agent"],
        sessionFilter: ["slack:direct:", "tail$"],
      }),
    ).toBe(true);
  });

  it("can fall back to the session-key agent id", () => {
    expect(
      matchesApprovalRequestFilters({
        request: {
          sessionKey: "agent:ops-agent:telegram:group:-1001",
        },
        agentFilter: ["ops-agent"],
        fallbackAgentIdFromSessionKey: true,
      }),
    ).toBe(true);
    expect(
      matchesApprovalRequestFilters({
        request: {
          sessionKey: "agent:ops-agent:telegram:group:-1001",
        },
        agentFilter: ["ops-agent"],
      }),
    ).toBe(false);
  });

  it("rejects unsafe regex patterns in session filters", () => {
    expect(
      matchesApprovalRequestFilters({
        request: { sessionKey: `${"a".repeat(28)}!` },
        sessionFilter: ["(a+)+$"],
      }),
    ).toBe(false);
  });

  it("rejects grouped start anchors that only match mid-key on oversize keys", () => {
    expect(
      matchesApprovalRequestFilters({
        request: {
          sessionKey: `${"E".repeat(2048)}agent:ops:leak${"Z".repeat(2500)}`,
        },
        sessionFilter: ["(?:^agent:ops:)"],
      }),
    ).toBe(false);
    expect(
      matchesApprovalRequestFilters({
        request: {
          sessionKey: `agent:ops:ghost${"y".repeat(5000)}`,
        },
        sessionFilter: ["(?:^agent:ops:)"],
      }),
    ).toBe(true);
  });
});
