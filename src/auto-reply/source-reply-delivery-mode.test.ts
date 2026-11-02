import { describe, expect, it } from "vitest";
import { buildHarnessVisibleReplyGuidance } from "./source-reply-delivery-mode.js";

describe("buildHarnessVisibleReplyGuidance", () => {
  it.each(["automatic", "message_tool_only"])(
    "uses the caller's final response when no source conversation exists (%s)",
    (sourceReplyDeliveryMode) => {
      for (const messageToolAvailable of [true, false]) {
        const guidance = buildHarnessVisibleReplyGuidance({
          sourceReplyDeliveryMode,
          messageToolAvailable,
          currentConversation: { agentSessionKey: "agent:main:operator" },
          requireExplicitMessageTarget: false,
          messageToolFinalByDefault: false,
        });
        expect(guidance).toContain(
          "OpenClaw delivers your final response automatically to the caller",
        );
        expect(guidance.includes("target required this turn")).toBe(messageToolAvailable);
        expect(guidance.includes("omitting `final` means `final=false`")).toBe(
          messageToolAvailable,
        );
        expect(guidance).toContain("Include all pending answers in your final response");
        expect(guidance).not.toContain("current source");
      }
    },
  );

  it("preserves channel-sourced reply guidance", () => {
    expect(
      buildHarnessVisibleReplyGuidance({
        sourceReplyDeliveryMode: "automatic",
        messageToolAvailable: true,
        currentConversation: { currentChannelProvider: "telegram", currentChannelId: "123" },
        requireExplicitMessageTarget: false,
      }),
    ).toBe(
      "OpenClaw delivers your final response automatically unless you have already completed the reply to this conversation with the message tool.\n\n" +
        "Use `final=false` for message-tool sends when more work or another reply must follow, including attachments before the final answer. Set `final=true`, or omit it, for a completed reply to this conversation. Finish the work before that send; do not expect another model step after confirmed final delivery. Do not send the reply again. If reactions are permitted, adding a reaction to the current message with `final=true` can also complete the reply.\n\n" +
        "`send`: `message`; this conversation is the default target. Set `target` for another destination.\n\n" +
        "Answer mid-task questions or status requests with `message(action=send, final=false)`, then resume work. Deliver all remaining answers before finishing; do not rely on intermediate narration being delivered.",
    );
  });
});

it.each(["automatic", "message_tool_only"])(
  "limits %s guidance to available capabilities",
  (mode) => {
    for (const available of [false, true]) {
      const text = buildHarnessVisibleReplyGuidance({
        sourceReplyDeliveryMode: mode,
        messageToolAvailable: available,
        messageToolFinalByDefault: false,
        currentConversation: { currentChannelProvider: "telegram", currentChannelId: "123" },
      });
      expect(text).not.toMatch(/commentary|progress_card|for progress/i);
      expect(text.includes("message(action=send")).toBe(available);
      expect(text.includes("omitting `final` means `final=false`")).toBe(available);
      expect(text).not.toContain("or omit it");
      expect(text.includes("If reactions are permitted")).toBe(available);
      if (!available && mode === "message_tool_only") {
        expect(text).toContain("No reply can be sent to this conversation");
      }
    }
  },
);
