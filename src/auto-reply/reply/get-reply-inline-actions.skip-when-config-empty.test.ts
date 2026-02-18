import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const handleCommandsMock = vi.fn();

vi.mock("./commands.js", () => ({
  handleCommands: (...args: unknown[]) => handleCommandsMock(...args),
  buildStatusReply: vi.fn(),
  buildCommandContext: vi.fn(),
}));

// Import after mocks.
const { handleInlineActions } = await import("./get-reply-inline-actions.js");

describe("handleInlineActions", () => {
  it("skips whatsapp replies when config is empty and From !== To", async () => {
    handleCommandsMock.mockReset();

    const typing: TypingController = {
      onReplyStart: async () => {},
      startTypingLoop: async () => {},
      startTypingOnText: async () => {},
      refreshTypingTtl: () => {},
      isActive: () => false,
      markRunComplete: () => {},
      markDispatchIdle: () => {},
      cleanup: vi.fn(),
    };

    const ctx = buildTestCtx({
      From: "whatsapp:+999",
      To: "whatsapp:+123",
      Body: "hi",
    });

    const result = await handleInlineActions({
      ctx,
      sessionCtx: ctx as unknown as TemplateContext,
      cfg: {},
      agentId: "main",
      sessionKey: "s:main",
      workspaceDir: "/tmp",
      isGroup: false,
      typing,
      allowTextCommands: false,
      inlineStatusRequested: false,
      command: {
        surface: "whatsapp",
        channel: "whatsapp",
        channelId: "whatsapp",
        ownerList: [],
        senderIsOwner: false,
        isAuthorizedSender: false,
        senderId: undefined,
        abortKey: "whatsapp:+999",
        rawBodyNormalized: "hi",
        commandBodyNormalized: "hi",
        from: "whatsapp:+999",
        to: "whatsapp:+123",
      },
      directives: clearInlineDirectives("hi"),
      cleanedBody: "hi",
      elevatedEnabled: false,
      elevatedAllowed: false,
      elevatedFailures: [],
      defaultActivation: () => "always",
      resolvedThinkLevel: undefined,
      resolvedVerboseLevel: undefined,
      resolvedReasoningLevel: "off",
      resolvedElevatedLevel: "off",
      resolveDefaultThinkingLevel: async () => "off",
      provider: "openai",
      model: "gpt-4o-mini",
      contextTokens: 0,
      abortedLastRun: false,
      sessionScope: "per-sender",
    });

    expect(result).toEqual({ kind: "reply", reply: undefined });
    expect(typing.cleanup).toHaveBeenCalled();
    expect(handleCommandsMock).not.toHaveBeenCalled();
  });
});
