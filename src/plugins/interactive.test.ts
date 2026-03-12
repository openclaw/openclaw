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
});
