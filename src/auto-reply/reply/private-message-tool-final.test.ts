// Tests private message-tool final delivery and visibility suppression.
import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { describe, expect, it } from "vitest";
import { classifyPrivateMessageToolFinal } from "./private-message-tool-final.js";

const base = {
  sourceReplyDeliveryMode: "message_tool_only" as const,
  sendPolicyDenied: false,
  successfulSourceReplyDelivery: false,
  isHeartbeat: false,
  isRoomEvent: false,
  finalText:
    "Here is the answer the user asked for. It includes enough detail to look like a visible response rather than an internal no-op note.",
};

function shouldWarnAboutPrivateMessageToolFinal(
  params: Parameters<typeof classifyPrivateMessageToolFinal>[0],
): boolean {
  return classifyPrivateMessageToolFinal(params) === "substantive";
}

describe("shouldWarnAboutPrivateMessageToolFinal", () => {
  it("flags a multi-sentence private final that was never delivered via the message tool (#85714)", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal(base)).toBe(true);
  });

  it("flags a long private final even without multiple sentence terminators", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "x".repeat(280),
      }),
    ).toBe(true);
  });

  it("does not flag automatic delivery mode (final text is delivered normally)", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, sourceReplyDeliveryMode: "automatic" }),
    ).toBe(false);
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, sourceReplyDeliveryMode: undefined }),
    ).toBe(false);
  });

  it("does not flag when the message tool already delivered this turn", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, successfulSourceReplyDelivery: true }),
    ).toBe(false);
  });

  it("does not flag silent sentinel variants (intentional silence)", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "NO_REPLY" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "  no_reply  " })).toBe(
      false,
    );
    expect(
      shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "NO_REPLY\n\nNO_REPLY" }),
    ).toBe(false);
  });

  it("does not flag a short private final", () => {
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "Nothing to add here.",
      }),
    ).toBe(false);
    expect(
      shouldWarnAboutPrivateMessageToolFinal({
        ...base,
        finalText: "I do not need to send anything. Nothing else to add.",
      }),
    ).toBe(false);
  });

  // Raw UTF-16 length misses substantive CJK replies; recovery needs estimated length (#115555).
  it.each([
    {
      label: "single-sentence CJK paragraph (length alone is substantive)",
      finalText: `${"字".repeat(150)}。`,
      expected: true,
    },
    { label: "short CJK acknowledgement", finalText: "沒有需要補充的。已完成。", expected: false },
  ])("$label -> $expected", ({ finalText, expected }) => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText })).toBe(expected);
  });

  it.each([
    { label: "ideographic full stop", terminator: "。" },
    { label: "full-width exclamation mark", terminator: "！" },
    { label: "full-width question mark", terminator: "？" },
    { label: "full-width full stop", terminator: "．" },
    { label: "half-width ideographic full stop", terminator: "｡" },
  ])("flags a medium-length CJK reply with $label", ({ terminator }) => {
    const finalText =
      `第一項設定已完成，請檢查通知狀態${terminator}` +
      `第二項資料已同步，稍後即可收到訊息${terminator}`;
    const estimatedChars = estimateStringChars(finalText);

    expect(estimatedChars).toBeGreaterThanOrEqual(120);
    expect(estimatedChars).toBeLessThan(280);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText })).toBe(true);
  });

  it("leaves accented Latin on raw length", () => {
    const finalText = `Le café est prêt. ${"x".repeat(100)}`;
    expect(finalText.length).toBeLessThan(280);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText })).toBe(false);
  });

  it("does not flag empty or whitespace-only final text", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "" })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, finalText: "   \n " })).toBe(false);
  });

  it("does not flag when delivery was intentionally denied by send policy", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, sendPolicyDenied: true })).toBe(false);
  });

  it("does not flag heartbeat or room-event non-delivery", () => {
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, isHeartbeat: true })).toBe(false);
    expect(shouldWarnAboutPrivateMessageToolFinal({ ...base, isRoomEvent: true })).toBe(false);
  });
});
