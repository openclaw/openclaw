import { beforeEach, describe, expect, it, vi } from "vitest";

const hookMocks = vi.hoisted(() => ({
  runner: {
    hasHooks: vi.fn(() => false),
    runMessageSent: vi.fn(async () => {}),
  },
}));

const internalHookMocks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(() => ({ type: "event" })),
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookMocks.runner,
}));

vi.mock("./internal-hooks.js", () => ({
  createInternalHookEvent: internalHookMocks.createInternalHookEvent,
  triggerInternalHook: internalHookMocks.triggerInternalHook,
}));

const { emitMessageSentHooks } = await import("./message-sent.js");

describe("emitMessageSentHooks", () => {
  beforeEach(() => {
    hookMocks.runner.hasHooks.mockReset();
    hookMocks.runner.hasHooks.mockReturnValue(false);
    hookMocks.runner.runMessageSent.mockClear();
    internalHookMocks.createInternalHookEvent.mockClear();
    internalHookMocks.triggerInternalHook.mockClear();
  });

  it("emits plugin and internal hooks when sessionKey is present", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    emitMessageSentHooks({
      to: "chat-1",
      content: "hello",
      success: true,
      channelId: "telegram",
      accountId: "work",
      sessionKey: "session-1",
      messageId: "msg-1",
    });

    await Promise.resolve();

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      {
        to: "chat-1",
        content: "hello",
        success: true,
      },
      {
        channelId: "telegram",
        accountId: "work",
        conversationId: "chat-1",
      },
    );
    expect(internalHookMocks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "session-1",
      {
        to: "chat-1",
        content: "hello",
        success: true,
        channelId: "telegram",
        accountId: "work",
        conversationId: "chat-1",
        messageId: "msg-1",
      },
    );
    expect(internalHookMocks.triggerInternalHook).toHaveBeenCalledWith({ type: "event" });
  });

  it("skips internal hook emission when sessionKey is missing", async () => {
    hookMocks.runner.hasHooks.mockReturnValue(true);

    emitMessageSentHooks({
      to: "chat-2",
      content: "hello",
      success: false,
      error: "send failed",
      channelId: "slack",
      accountId: "team",
    });

    await Promise.resolve();

    expect(hookMocks.runner.runMessageSent).toHaveBeenCalledWith(
      {
        to: "chat-2",
        content: "hello",
        success: false,
        error: "send failed",
      },
      {
        channelId: "slack",
        accountId: "team",
        conversationId: "chat-2",
      },
    );
    expect(internalHookMocks.createInternalHookEvent).not.toHaveBeenCalled();
    expect(internalHookMocks.triggerInternalHook).not.toHaveBeenCalled();
  });
});
