import { describe, expect, it } from "vitest";
import { buildHarnessVisibleReplyGuidance } from "./source-reply-delivery-mode.js";

describe("buildHarnessVisibleReplyGuidance", () => {
  it.each(["automatic", "message_tool_only"])(
    "uses the caller's final response when no source conversation exists (%s)",
    (sourceReplyDeliveryMode) => {
      const guidance = buildHarnessVisibleReplyGuidance({
        sourceReplyDeliveryMode,
        messageToolAvailable: true,
        currentConversation: { agentSessionKey: "agent:main:operator" },
        requireExplicitMessageTarget: false,
        messageToolFinalByDefault: false,
      });

      expect(guidance).toContain(
        "OpenClaw delivers your final response automatically to the caller",
      );
      expect(guidance).toContain("`target` + `message`; target required this turn");
      expect(guidance).toContain(
        "including questions received during ongoing work, in your final response",
      );
      for (const unavailable of ["current source", "final=false", "A send ends this turn"]) {
        expect(guidance).not.toContain(unavailable);
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
      "Use `message` with `final=false` for progress. A completed send to the current source conversation (`final=true`, or omitted) or an added reaction to its current message with `final=true` is your complete reply. Do not repeat delivered content. Otherwise, OpenClaw delivers your final response automatically.\n\n" +
        "`send`: `message`; current source is default target. Set `target` only elsewhere.\n\n" +
        "Commentary is optional progress and may be hidden. Answer user questions or status requests received during ongoing work with `message(action=send, final=false)`, then continue the task. Before finishing, deliver every still-pending answer through this turn's visible-reply route. Do not repeat answers already delivered.",
    );
  });
});
