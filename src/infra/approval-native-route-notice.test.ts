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
  it("shortens exec approval ids to an 8-char slug", () => {
    const id = "abc12345-extra-suffix";
    const result = resolveApprovalDeliveryFailedNoticeText({
      approvalId: id,
      approvalKind: "exec",
    });
    expect(result).toContain("/approve abc12345");
  });

  it("keeps short exec ids unshortened", () => {
    const result = resolveApprovalDeliveryFailedNoticeText({
      approvalId: "abc",
      approvalKind: "exec",
    });
    expect(result).toContain("/approve abc");
  });

  it("keeps plugin approval ids unshortened regardless of length", () => {
    const longId = "x".repeat(20);
    const result = resolveApprovalDeliveryFailedNoticeText({
      approvalId: longId,
      approvalKind: "plugin",
    });
    expect(result).toContain(`/approve ${longId}`);
  });

  // 🦞 is U+1F99E = surrogate pair 🦞
  it("does not produce a lone surrogate when an emoji straddles the 8-char slug boundary", () => {
    // 7 ASCII chars + lobster emoji (2 code units) = 9 code units
    const id = "1234567🦞extra";
    const result = resolveApprovalDeliveryFailedNoticeText({
      approvalId: id,
      approvalKind: "exec",
    });

    const slugMatch = result.match(/\/approve (\S+)/);
    expect(slugMatch).not.toBeNull();
    const slug = slugMatch![1]!;

    // The slug must not end with a lone high surrogate.
    const lastChar = slug.charCodeAt(slug.length - 1);
    const isHighSurrogate = lastChar >= 0xd800 && lastChar <= 0xdbff;
    expect(isHighSurrogate).toBe(false);
  });

  it("preserves an emoji fully within the 8-char slug boundary", () => {
    // 6 ASCII + lobster (2 code units) = 8 code units exactly at limit
    const id = "123456🦞extra";
    const result = resolveApprovalDeliveryFailedNoticeText({
      approvalId: id,
      approvalKind: "exec",
    });
    expect(result).toContain("/approve 123456🦞");
  });
});
