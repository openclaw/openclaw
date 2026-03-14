import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
  isMessageReceivedEvent,
  type InternalHookHandler,
} from "../hooks/internal-hooks.js";

describe("chat.inbound broadcast hook", () => {
  let broadcast: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
  let chatInboundHookHandler: InternalHookHandler;

  beforeEach(() => {
    clearInternalHooks();
    broadcast = vi.fn();

    // Replicate the hook handler from server.impl.ts
    chatInboundHookHandler = async (event) => {
      if (!isMessageReceivedEvent(event)) {
        return;
      }
      const { channelId } = event.context;
      if (channelId === "webchat") {
        return;
      }
      broadcast(
        "chat.inbound",
        {
          sessionKey: event.sessionKey,
          channelId,
          timestamp: event.timestamp.toISOString(),
        },
        { dropIfSlow: true },
      );
    };
    registerInternalHook("message:received", chatInboundHookHandler);
  });

  afterEach(() => {
    clearInternalHooks();
  });

  it("should broadcast chat.inbound for telegram messages", async () => {
    const event = createInternalHookEvent("message", "received", "agent:main:telegram:1234", {
      from: "user:1234",
      content: "Hello from Telegram",
      channelId: "telegram",
      conversationId: "conv-1",
    });

    await triggerInternalHook(event);

    expect(broadcast).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(
      "chat.inbound",
      {
        sessionKey: "agent:main:telegram:1234",
        channelId: "telegram",
        timestamp: expect.any(String),
      },
      { dropIfSlow: true },
    );
  });

  it("should skip webchat-originated messages", async () => {
    const event = createInternalHookEvent("message", "received", "agent:main:webchat:abc", {
      from: "webchat-user",
      content: "Hello from Control UI",
      channelId: "webchat",
      conversationId: "conv-2",
    });

    await triggerInternalHook(event);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("should skip non-message:received events", async () => {
    const event = createInternalHookEvent("message", "sent", "agent:main:telegram:1234", {
      to: "user:1234",
      content: "Reply from assistant",
      channelId: "telegram",
    });

    await triggerInternalHook(event);

    expect(broadcast).not.toHaveBeenCalled();
  });

  it("should include sessionKey in the broadcast payload", async () => {
    const sessionKey = "agent:main:discord:channel:9876";
    const event = createInternalHookEvent("message", "received", sessionKey, {
      from: "user:5678",
      content: "Hello from Discord",
      channelId: "discord",
      conversationId: "conv-3",
    });

    await triggerInternalHook(event);

    expect(broadcast).toHaveBeenCalledOnce();
    const payload = broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(payload.sessionKey).toBe(sessionKey);
    expect(payload.channelId).toBe("discord");
  });

  it("should broadcast for different channel types", async () => {
    const channels = ["telegram", "discord", "signal", "whatsapp", "slack"];

    for (const channel of channels) {
      broadcast.mockClear();
      const event = createInternalHookEvent("message", "received", `agent:main:${channel}:user1`, {
        from: "user:1",
        content: `Hello from ${channel}`,
        channelId: channel,
      });

      await triggerInternalHook(event);

      expect(broadcast).toHaveBeenCalledOnce();
      const payload = broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(payload.channelId).toBe(channel);
    }
  });

  it("should produce a valid ISO timestamp", async () => {
    const event = createInternalHookEvent("message", "received", "agent:main:telegram:1234", {
      from: "user:1234",
      content: "Timestamp test",
      channelId: "telegram",
    });

    await triggerInternalHook(event);

    const payload = broadcast.mock.calls[0]?.[1] as Record<string, unknown>;
    const ts = payload.timestamp as string;
    expect(() => new Date(ts)).not.toThrow();
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
