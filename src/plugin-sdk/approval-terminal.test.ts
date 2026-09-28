// Tests shared approval terminal labeling across approval kinds.
import { describe, expect, it } from "vitest";
import type { PluginApprovalResolvedView } from "../infra/approval-view-model.types.js";
import {
  formatApprovalDecisionLabel,
  formatChannelApprovalResolvedLabel,
} from "./approval-terminal.js";

function pluginResolvedView(
  overrides: Partial<PluginApprovalResolvedView>,
): PluginApprovalResolvedView {
  return {
    approvalKind: "plugin",
    phase: "resolved",
    decision: "deny",
    ...overrides,
  };
}

describe("formatChannelApprovalResolvedLabel", () => {
  it("renders a plugin expiry as Expired, not Denied", () => {
    const label = formatChannelApprovalResolvedLabel(
      pluginResolvedView({ terminalStatus: "expired" }),
    );
    expect(label).toBe("Expired");
  });

  it("renders a plugin cancellation as Cancelled", () => {
    const label = formatChannelApprovalResolvedLabel(
      pluginResolvedView({ terminalStatus: "cancelled" }),
    );
    expect(label).toBe("Cancelled");
  });

  it("keeps the transport decision spelling for a genuine plugin deny", () => {
    const label = formatChannelApprovalResolvedLabel(pluginResolvedView({}), (decision) =>
      decision === "deny" ? "REJECTED" : decision,
    );
    expect(label).toBe("REJECTED");
  });

  it("labels a plain recorded decision without terminal status", () => {
    expect(formatApprovalDecisionLabel("deny")).toBe("Denied");
  });
});
