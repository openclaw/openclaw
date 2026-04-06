import { describe, expect, it } from "vitest";
import {
  describeExecApprovalDeliveryDestination,
  resolveExecApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";

describe("describeExecApprovalDeliveryDestination", () => {
  it("labels approver-DM-only delivery as channel DMs", () => {
    expect(
      describeExecApprovalDeliveryDestination({
        channelLabel: "Telegram",
        deliveredTargets: [
          {
            surface: "approver-dm",
            target: { to: "111" },
            reason: "fallback",
          },
        ],
      }),
    ).toBe("Telegram DMs");
  });

  it("labels mixed-surface delivery as the channel itself", () => {
    expect(
      describeExecApprovalDeliveryDestination({
        channelLabel: "Matrix",
        deliveredTargets: [
          {
            surface: "origin",
            target: { to: "room:!abc:example.com" },
            reason: "preferred",
          },
        ],
      }),
    ).toBe("Matrix");
  });
});

describe("resolveExecApprovalRoutedElsewhereNoticeText", () => {
  it("reports sorted unique destinations", () => {
    expect(
      resolveExecApprovalRoutedElsewhereNoticeText(["Telegram DMs", "Matrix DMs", "Telegram DMs"]),
    ).toBe(
      "Approval required. I sent the approval request to Matrix DMs or Telegram DMs, not this chat.",
    );
  });

  it("suppresses the notice when there are no destinations", () => {
    expect(resolveExecApprovalRoutedElsewhereNoticeText([])).toBeNull();
  });
});
