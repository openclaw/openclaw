// Covers approval delivery destination labels and reroute notices.
import { describe, expect, it } from "vitest";
import {
  describeApprovalDeliveryDestination,
  resolveApprovalDeliveryFailedNoticeText,
  resolveApprovalRoutedElsewhereNoticeText,
} from "./approval-native-route-notice.js";

describe("describeApprovalDeliveryDestination", () => {
  it("labels approver-DM-only delivery as channel DMs", () => {
    expect(
      describeApprovalDeliveryDestination({
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
      describeApprovalDeliveryDestination({
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

describe("resolveApprovalRoutedElsewhereNoticeText", () => {
  it("reports sorted unique destinations", () => {
    expect(
      resolveApprovalRoutedElsewhereNoticeText(["Telegram DMs", "Matrix DMs", "Telegram DMs"]),
    ).toBe(
      "Approval required. I sent the approval request to Matrix DMs or Telegram DMs, not this chat.",
    );
  });

  it("suppresses the notice when there are no destinations", () => {
    expect(resolveApprovalRoutedElsewhereNoticeText([])).toBeNull();
  });
});

describe("resolveApprovalDeliveryFailedNoticeText", () => {
  it("truncates long exec approval ids to 8 chars", () => {
    const notice = resolveApprovalDeliveryFailedNoticeText({
      approvalId: "exec-1234567890",
      approvalKind: "exec",
    });
    expect(notice).toContain("/approve exec-123 allow-once|allow-always|deny");
  });

  it("keeps short plugin approval ids intact", () => {
    const notice = resolveApprovalDeliveryFailedNoticeText({
      approvalId: "deploy",
      approvalKind: "plugin",
    });
    expect(notice).toContain("/approve deploy allow-once|allow-always|deny");
  });

  it("does not split UTF-16 surrogate pairs when truncating exec ids", () => {
    const id = "exec-12😀34567890";
    const notice = resolveApprovalDeliveryFailedNoticeText({
      approvalId: id,
      approvalKind: "exec",
    });
    expect(() => encodeURIComponent(notice)).not.toThrow();
    expect(notice).not.toMatch(
      /[\uD800-\uDFFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
    );
    expect(notice).toContain("use the full id in /approve");
  });
});
