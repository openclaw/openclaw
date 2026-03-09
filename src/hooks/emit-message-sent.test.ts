import { beforeEach, describe, expect, it, vi } from "vitest";
import { emitMessageSentHook } from "./emit-message-sent.js";

const hookRunner = vi.hoisted(() => ({
  hasHooks: vi.fn<(name: string) => boolean>(() => false),
  runMessageSent: vi.fn(async () => {}),
}));
const internalHooks = vi.hoisted(() => ({
  createInternalHookEvent: vi.fn(
    (resource: string, action: string, sessionKey: string, data: Record<string, unknown>) => ({
      resource,
      action,
      sessionKey,
      data,
    }),
  ),
  triggerInternalHook: vi.fn(async () => {}),
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => hookRunner,
}));
vi.mock("./internal-hooks.js", () => ({
  createInternalHookEvent: (...args: Parameters<typeof internalHooks.createInternalHookEvent>) =>
    internalHooks.createInternalHookEvent(...args),
  triggerInternalHook: (...args: Parameters<typeof internalHooks.triggerInternalHook>) =>
    internalHooks.triggerInternalHook(...args),
}));

describe("emitMessageSentHook", () => {
  beforeEach(() => {
    hookRunner.hasHooks.mockReset();
    hookRunner.hasHooks.mockReturnValue(false);
    hookRunner.runMessageSent.mockReset();
    hookRunner.runMessageSent.mockResolvedValue(undefined);
    internalHooks.createInternalHookEvent.mockClear();
    internalHooks.triggerInternalHook.mockClear();
    internalHooks.triggerInternalHook.mockResolvedValue(undefined);
  });

  it("fires plugin hook when message_sent hooks are registered", () => {
    hookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    emitMessageSentHook({
      to: "+1555",
      content: "hello",
      success: true,
      channelId: "signal",
      accountId: "acc1",
    });

    expect(hookRunner.runMessageSent).toHaveBeenCalledWith(
      { to: "+1555", content: "hello", success: true },
      { channelId: "signal", accountId: "acc1", conversationId: "+1555" },
    );
  });

  it("includes error in plugin hook on failure", () => {
    hookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    emitMessageSentHook({
      to: "chat:123",
      content: "hi",
      success: false,
      error: "timeout",
      channelId: "telegram",
    });

    expect(hookRunner.runMessageSent).toHaveBeenCalledWith(
      { to: "chat:123", content: "hi", success: false, error: "timeout" },
      expect.objectContaining({ channelId: "telegram" }),
    );
  });

  it("skips plugin hook when no hooks registered", () => {
    emitMessageSentHook({
      to: "+1555",
      content: "hello",
      success: true,
      channelId: "signal",
    });

    expect(hookRunner.runMessageSent).not.toHaveBeenCalled();
  });

  it("fires internal hook when sessionKey is provided", () => {
    emitMessageSentHook({
      to: "+1555",
      content: "hello",
      success: true,
      messageId: "msg-42",
      channelId: "signal",
      accountId: "acc1",
      sessionKey: "session-abc",
    });

    expect(internalHooks.createInternalHookEvent).toHaveBeenCalledWith(
      "message",
      "sent",
      "session-abc",
      {
        to: "+1555",
        content: "hello",
        success: true,
        channelId: "signal",
        accountId: "acc1",
        conversationId: "+1555",
        messageId: "msg-42",
      },
    );
    expect(internalHooks.triggerInternalHook).toHaveBeenCalled();
  });

  it("skips internal hook when sessionKey is missing", () => {
    emitMessageSentHook({
      to: "+1555",
      content: "hello",
      success: true,
      channelId: "signal",
    });

    expect(internalHooks.triggerInternalHook).not.toHaveBeenCalled();
  });

  it("fires both hooks when sessionKey is present and plugins registered", () => {
    hookRunner.hasHooks.mockImplementation((name: string) => name === "message_sent");

    emitMessageSentHook({
      to: "user:U1",
      content: "hey",
      success: true,
      messageId: "ts-1",
      channelId: "slack",
      accountId: "work",
      sessionKey: "sess-1",
    });

    expect(hookRunner.runMessageSent).toHaveBeenCalled();
    expect(internalHooks.triggerInternalHook).toHaveBeenCalled();
  });
});
