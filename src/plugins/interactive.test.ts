import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as conversationBinding from "./conversation-binding.js";
import {
  clearPluginInteractiveHandlers,
  dispatchPluginInteractiveHandler,
  registerPluginInteractiveHandler,
} from "./interactive.js";

let requestPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.requestPluginConversationBinding
>;
let detachPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.detachPluginConversationBinding
>;
let getCurrentPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.getCurrentPluginConversationBinding
>;

async function expectDedupedInteractiveDispatch(params: {
  baseParams: Parameters<typeof dispatchPluginInteractiveHandler>[0];
  handler: ReturnType<typeof vi.fn>;
  expectedCall: unknown;
}) {
  const first = await dispatchPluginInteractiveHandler(params.baseParams);
  const duplicate = await dispatchPluginInteractiveHandler(params.baseParams);

  expect(first).toEqual({ matched: true, handled: true, duplicate: false });
  expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
  expect(params.handler).toHaveBeenCalledTimes(1);
  expect(params.handler).toHaveBeenCalledWith(expect.objectContaining(params.expectedCall));
}

describe("plugin interactive handlers", () => {
  beforeEach(() => {
    clearPluginInteractiveHandlers();
    requestPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "requestPluginConversationBinding")
      .mockResolvedValue({
        status: "bound",
        binding: {
          bindingId: "binding-1",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          channel: "telegram",
          accountId: "default",
          conversationId: "-10099:topic:77",
          parentConversationId: "-10099",
          threadId: 77,
          boundAt: 1,
        },
      });
    detachPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "detachPluginConversationBinding")
      .mockResolvedValue({ removed: true });
    getCurrentPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "getCurrentPluginConversationBinding")
      .mockResolvedValue({
        bindingId: "binding-1",
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
        boundAt: 1,
      });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

    await expectDedupedInteractiveDispatch({
      baseParams,
      handler,
      expectedCall: {
        channel: "telegram",
        conversationId: "-10099:topic:77",
        callback: expect.objectContaining({
          namespace: "codex",
          payload: "resume:thread-1",
          chatId: "-10099",
          messageId: 55,
        }),
      },
    });
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

    await expectDedupedInteractiveDispatch({
      baseParams,
      handler,
      expectedCall: {
        channel: "discord",
        conversationId: "channel-1",
        interaction: expect.objectContaining({
          namespace: "codex",
          payload: "approve:thread-1",
          messageId: "message-1",
          values: ["allow"],
        }),
      },
    });
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

    await expectDedupedInteractiveDispatch({
      baseParams,
      handler,
      expectedCall: {
        channel: "slack",
        conversationId: "C123",
        threadId: "1710000000.000100",
        interaction: expect.objectContaining({
          namespace: "codex",
          payload: "approve:thread-1",
          actionId: "codex",
          messageTs: "1710000000.000200",
        }),
      },
    });
  });

  it("wires Telegram conversation binding helpers with topic context", async () => {
    const requestResult = {
      status: "bound" as const,
      binding: {
        bindingId: "binding-telegram",
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
        boundAt: 1,
      },
    };
    const currentBinding = {
      ...requestResult.binding,
      boundAt: 2,
    };
    requestPluginConversationBindingMock.mockResolvedValueOnce(requestResult);
    getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);

    const handler = vi.fn(async (ctx) => {
      await expect(
        ctx.requestConversationBinding({
          summary: "Bind this topic",
          detachHint: "Use /new to detach",
        }),
      ).resolves.toEqual(requestResult);
      await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
      await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler(
        "codex-plugin",
        {
          channel: "telegram",
          namespace: "codex",
          handler,
        },
        { pluginName: "Codex", pluginRoot: "/plugins/codex" },
      ),
    ).toEqual({ ok: true });

    await expect(
      dispatchPluginInteractiveHandler({
        channel: "telegram",
        data: "codex:bind",
        callbackId: "cb-bind",
        ctx: {
          accountId: "default",
          callbackId: "cb-bind",
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
      }),
    ).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });

    expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginId: "codex-plugin",
      pluginName: "Codex",
      pluginRoot: "/plugins/codex",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
      binding: {
        summary: "Bind this topic",
        detachHint: "Use /new to detach",
      },
    });
    expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
    });
    expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
    });
  });

  it("wires Discord conversation binding helpers with parent channel context", async () => {
    const requestResult = {
      status: "bound" as const,
      binding: {
        bindingId: "binding-discord",
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
        boundAt: 1,
      },
    };
    const currentBinding = {
      ...requestResult.binding,
      boundAt: 2,
    };
    requestPluginConversationBindingMock.mockResolvedValueOnce(requestResult);
    getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);

    const handler = vi.fn(async (ctx) => {
      await expect(ctx.requestConversationBinding({ summary: "Bind Discord" })).resolves.toEqual(
        requestResult,
      );
      await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
      await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler(
        "codex-plugin",
        {
          channel: "discord",
          namespace: "codex",
          handler,
        },
        { pluginName: "Codex", pluginRoot: "/plugins/codex" },
      ),
    ).toEqual({ ok: true });

    await expect(
      dispatchPluginInteractiveHandler({
        channel: "discord",
        data: "codex:bind",
        interactionId: "ix-bind",
        ctx: {
          accountId: "default",
          interactionId: "ix-bind",
          conversationId: "channel-1",
          parentConversationId: "parent-1",
          guildId: "guild-1",
          senderId: "user-1",
          senderUsername: "ada",
          auth: { isAuthorizedSender: true },
          interaction: {
            kind: "button",
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
      }),
    ).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });

    expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginId: "codex-plugin",
      pluginName: "Codex",
      pluginRoot: "/plugins/codex",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
      binding: {
        summary: "Bind Discord",
      },
    });
    expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
    });
    expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
    });
  });

  it("wires Slack conversation binding helpers with thread context", async () => {
    const requestResult = {
      status: "bound" as const,
      binding: {
        bindingId: "binding-slack",
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
        boundAt: 1,
      },
    };
    const currentBinding = {
      ...requestResult.binding,
      boundAt: 2,
    };
    requestPluginConversationBindingMock.mockResolvedValueOnce(requestResult);
    getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);

    const handler = vi.fn(async (ctx) => {
      await expect(ctx.requestConversationBinding({ summary: "Bind Slack" })).resolves.toEqual(
        requestResult,
      );
      await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
      await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler(
        "codex-plugin",
        {
          channel: "slack",
          namespace: "codex",
          handler,
        },
        { pluginName: "Codex", pluginRoot: "/plugins/codex" },
      ),
    ).toEqual({ ok: true });

    await expect(
      dispatchPluginInteractiveHandler({
        channel: "slack",
        data: "codex:bind",
        interactionId: "slack-bind",
        ctx: {
          accountId: "default",
          interactionId: "slack-bind",
          conversationId: "C123",
          parentConversationId: "C123",
          threadId: "1710000000.000100",
          senderId: "user-1",
          senderUsername: "ada",
          auth: { isAuthorizedSender: true },
          interaction: {
            kind: "button",
            actionId: "codex",
            blockId: "codex_actions",
            messageTs: "1710000000.000200",
            threadTs: "1710000000.000100",
            value: "bind",
            selectedValues: ["bind"],
            selectedLabels: ["Bind"],
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
      }),
    ).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });

    expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginId: "codex-plugin",
      pluginName: "Codex",
      pluginRoot: "/plugins/codex",
      requestedBySenderId: "user-1",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
      binding: {
        summary: "Bind Slack",
      },
    });
    expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
    });
    expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
      pluginRoot: "/plugins/codex",
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
    });
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
