import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the dependencies before importing the module under test
vi.mock("../../hooks/internal-hooks.js", () => ({
  createInternalHookEvent: vi.fn(
    (type: string, action: string, sessionKey: string, context: Record<string, unknown>) => ({
      type,
      action,
      sessionKey,
      context,
      timestamp: new Date(),
      messages: [],
    }),
  ),
  triggerInternalHook: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

import { triggerInternalHook, createInternalHookEvent } from "../../hooks/internal-hooks.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { emitMessageSentHookForReply } from "./emit-message-sent-hook.js";

describe("emitMessageSentHookForReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits internal hook with correct context when sessionKey is provided", () => {
    emitMessageSentHookForReply(
      { text: "Hello world" },
      {
        sessionKey: "test-session-key",
        channelId: "discord",
        accountId: "acc-123",
        to: "channel-456",
      },
    );

    expect(createInternalHookEvent).toHaveBeenCalledWith("message", "sent", "test-session-key", {
      to: "channel-456",
      content: "Hello world",
      success: true,
      channelId: "discord",
      accountId: "acc-123",
      conversationId: "channel-456",
    });
    expect(triggerInternalHook).toHaveBeenCalled();
  });

  it("does not emit internal hook when sessionKey is missing", () => {
    emitMessageSentHookForReply(
      { text: "Hello" },
      {
        channelId: "discord",
        to: "channel-456",
      },
    );

    expect(triggerInternalHook).not.toHaveBeenCalled();
  });

  it("uses empty string for content when payload has no text", () => {
    emitMessageSentHookForReply(
      {},
      {
        sessionKey: "test-key",
        channelId: "slack",
        to: "C123",
      },
    );

    expect(createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "test-key",
      expect.objectContaining({ content: "" }),
    );
  });

  it("emits plugin hook when hookRunner has message_sent hooks", () => {
    const mockRunner = {
      hasHooks: vi.fn((name: string) => name === "message_sent"),
      runMessageSent: vi.fn(() => Promise.resolve()),
    };
    vi.mocked(getGlobalHookRunner).mockReturnValue(mockRunner as unknown);

    emitMessageSentHookForReply(
      { text: "test" },
      {
        sessionKey: "sk",
        channelId: "telegram",
        accountId: "bot-1",
        to: "chat-789",
      },
    );

    expect(mockRunner.runMessageSent).toHaveBeenCalledWith(
      { to: "chat-789", content: "test", success: true },
      { channelId: "telegram", accountId: "bot-1", conversationId: "chat-789" },
    );
  });

  it("does not throw when hookRunner throws", () => {
    const mockRunner = {
      hasHooks: () => {
        throw new Error("hook error");
      },
    };
    vi.mocked(getGlobalHookRunner).mockReturnValue(mockRunner as unknown);

    // Should not throw
    expect(() =>
      emitMessageSentHookForReply(
        { text: "test" },
        { sessionKey: "sk", channelId: "discord", to: "ch" },
      ),
    ).not.toThrow();
  });
});
