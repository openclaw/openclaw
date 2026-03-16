import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginInteractiveHandlers,
  dispatchPluginInteractiveHandler,
  registerPluginInteractiveHandler,
} from "./interactive.js";

describe("plugin interactive handlers", () => {
  beforeEach(() => {
    clearPluginInteractiveHandlers();
  });

  it("routes Telegram callbacks by namespace and dedupes callback ids", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = {
      channel: "telegram" as const,
      data: "codex:resume:thread-1",
      callbackId: "cb-1",
      ctx: {
        accountId: "default",
        callbackId: "cb-1",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        senderId: "user-1",
        senderUsername: "ada",
        threadId: 77,
        isGroup: true,
        isForum: true,
        auth: { isAuthorizedSender: true },
        callbackMessage: {
          messageId: 55,
          chatId: "-10099",
          messageText: "Pick a thread",
        },
      },
      respond: {
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        editButtons: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
      },
    };

    const first = await dispatchPluginInteractiveHandler(baseParams);
    const duplicate = await dispatchPluginInteractiveHandler(baseParams);

    expect(first).toEqual({ matched: true, handled: true, duplicate: false });
    expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        conversationId: "-10099:topic:77",
        callback: expect.objectContaining({
          namespace: "codex",
          payload: "resume:thread-1",
          chatId: "-10099",
          messageId: 55,
        }),
      }),
    );
  });

  it("rejects duplicate namespace registrations", () => {
    const first = registerPluginInteractiveHandler("plugin-a", {
      channel: "telegram",
      namespace: "codex",
      handler: async () => ({ handled: true }),
    });
    const second = registerPluginInteractiveHandler("plugin-b", {
      channel: "telegram",
      namespace: "codex",
      handler: async () => ({ handled: true }),
    });

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      ok: false,
      error: 'Interactive handler namespace "codex" already registered by plugin "plugin-a"',
    });
  });

  it("routes Discord interactions by namespace and dedupes interaction ids", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "discord",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = {
      channel: "discord" as const,
      data: "codex:approve:thread-1",
      interactionId: "ix-1",
      ctx: {
        accountId: "default",
        interactionId: "ix-1",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
        guildId: "guild-1",
        senderId: "user-1",
        senderUsername: "ada",
        auth: { isAuthorizedSender: true },
        interaction: {
          kind: "button" as const,
          messageId: "message-1",
          values: ["allow"],
        },
      },
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        clearComponents: vi.fn(async () => {}),
      },
    };

    const first = await dispatchPluginInteractiveHandler(baseParams);
    const duplicate = await dispatchPluginInteractiveHandler(baseParams);

    expect(first).toEqual({ matched: true, handled: true, duplicate: false });
    expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        conversationId: "channel-1",
        interaction: expect.objectContaining({
          namespace: "codex",
          payload: "approve:thread-1",
          messageId: "message-1",
          values: ["allow"],
        }),
      }),
    );
  });

  it("routes Slack interactions by namespace and dedupes interaction ids", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "slack",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = {
      channel: "slack" as const,
      data: "codex:approve:thread-1",
      interactionId: "slack-ix-1",
      ctx: {
        channel: "slack" as const,
        accountId: "default",
        interactionId: "slack-ix-1",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
        senderId: "U123",
        senderUsername: "ada",
        auth: { isAuthorizedSender: true },
        interaction: {
          kind: "button" as const,
          actionId: "codex",
          blockId: "codex_actions",
          messageTs: "1710000000.000200",
          threadTs: "1710000000.000100",
          value: "approve:thread-1",
          selectedValues: ["approve:thread-1"],
          selectedLabels: ["Approve"],
          triggerId: "trigger-1",
          responseUrl: "https://hooks.slack.test/response",
        },
      },
      respond: {
        acknowledge: vi.fn(async () => {}),
        reply: vi.fn(async () => {}),
        followUp: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
      },
    };

    const first = await dispatchPluginInteractiveHandler(baseParams);
    const duplicate = await dispatchPluginInteractiveHandler(baseParams);

    expect(first).toEqual({ matched: true, handled: true, duplicate: false });
    expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        conversationId: "C123",
        threadId: "1710000000.000100",
        interaction: expect.objectContaining({
          namespace: "codex",
          payload: "approve:thread-1",
          actionId: "codex",
          messageTs: "1710000000.000200",
        }),
      }),
    );
  });

  it("does not consume dedupe keys when a handler throws", async () => {
    const handler = vi
      .fn(async () => ({ handled: true }))
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({ handled: true });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    const baseParams = {
      channel: "telegram" as const,
      data: "codex:resume:thread-1",
      callbackId: "cb-throw",
      ctx: {
        accountId: "default",
        callbackId: "cb-throw",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        senderId: "user-1",
        senderUsername: "ada",
        threadId: 77,
        isGroup: true,
        isForum: true,
        auth: { isAuthorizedSender: true },
        callbackMessage: {
          messageId: 55,
          chatId: "-10099",
          messageText: "Pick a thread",
        },
      },
      respond: {
        reply: vi.fn(async () => {}),
        editMessage: vi.fn(async () => {}),
        editButtons: vi.fn(async () => {}),
        clearButtons: vi.fn(async () => {}),
        deleteMessage: vi.fn(async () => {}),
      },
    };

    await expect(dispatchPluginInteractiveHandler(baseParams)).rejects.toThrow("boom");
    await expect(dispatchPluginInteractiveHandler(baseParams)).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
