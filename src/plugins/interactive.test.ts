import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as conversationBinding from "./conversation-binding.js";
import type {
  DiscordInteractiveDispatchContext,
  MSTeamsInteractiveDispatchContext,
  SlackInteractiveDispatchContext,
  TelegramInteractiveDispatchContext,
} from "./interactive-dispatch-adapters.js";
import {
  clearPluginInteractiveHandlers,
  dispatchPluginInteractiveHandler,
  registerPluginInteractiveHandler,
} from "./interactive.js";
import type {
  PluginInteractiveDiscordHandlerContext,
  PluginInteractiveMSTeamsHandlerContext,
  PluginInteractiveSlackHandlerContext,
  PluginInteractiveTelegramHandlerContext,
} from "./types.js";

let requestPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.requestPluginConversationBinding
>;
let detachPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.detachPluginConversationBinding
>;
let getCurrentPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.getCurrentPluginConversationBinding
>;

type InteractiveDispatchParams =
  | {
      channel: "telegram";
      data: string;
      callbackId: string;
      ctx: TelegramInteractiveDispatchContext;
      respond: PluginInteractiveTelegramHandlerContext["respond"];
    }
  | {
      channel: "discord";
      data: string;
      interactionId: string;
      ctx: DiscordInteractiveDispatchContext;
      respond: PluginInteractiveDiscordHandlerContext["respond"];
    }
  | {
      channel: "slack";
      data: string;
      interactionId: string;
      ctx: SlackInteractiveDispatchContext;
      respond: PluginInteractiveSlackHandlerContext["respond"];
    }
  | {
      channel: "msteams";
      data: string;
      interactionId: string;
      ctx: MSTeamsInteractiveDispatchContext;
      respond: PluginInteractiveMSTeamsHandlerContext["respond"];
    };

type InteractiveModule = typeof import("./interactive.js");

const interactiveModuleUrl = new URL("./interactive.ts", import.meta.url).href;

async function importInteractiveModule(cacheBust: string): Promise<InteractiveModule> {
  return (await import(`${interactiveModuleUrl}?t=${cacheBust}`)) as InteractiveModule;
}

function createTelegramDispatchParams(params: {
  data: string;
  callbackId: string;
}): Extract<InteractiveDispatchParams, { channel: "telegram" }> {
  return {
    channel: "telegram",
    data: params.data,
    callbackId: params.callbackId,
    ctx: {
      accountId: "default",
      callbackId: params.callbackId,
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
}

function createDiscordDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<DiscordInteractiveDispatchContext["interaction"]>;
}): Extract<InteractiveDispatchParams, { channel: "discord" }> {
  return {
    channel: "discord",
    data: params.data,
    interactionId: params.interactionId,
    ctx: {
      accountId: "default",
      interactionId: params.interactionId,
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
        ...params.interaction,
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
}

function createSlackDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<SlackInteractiveDispatchContext["interaction"]>;
}): Extract<InteractiveDispatchParams, { channel: "slack" }> {
  return {
    channel: "slack",
    data: params.data,
    interactionId: params.interactionId,
    ctx: {
      accountId: "default",
      interactionId: params.interactionId,
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
        value: "approve:thread-1",
        selectedValues: ["approve:thread-1"],
        selectedLabels: ["Approve"],
        triggerId: "trigger-1",
        responseUrl: "https://hooks.slack.test/response",
        ...params.interaction,
      },
    },
    respond: {
      acknowledge: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
    },
  };
}

function createMSTeamsDispatchParams(params: {
  data: string;
  interactionId: string;
  interaction?: Partial<MSTeamsInteractiveDispatchContext["interaction"]>;
}): Extract<InteractiveDispatchParams, { channel: "msteams" }> {
  return {
    channel: "msteams",
    data: params.data,
    interactionId: params.interactionId,
    ctx: {
      accountId: "default",
      interactionId: params.interactionId,
      conversationId: "conversation:19:teams@thread.tacv2",
      senderId: "user-1",
      senderUsername: "ada",
      auth: { isAuthorizedSender: true },
      conversationType: "channel",
      teamId: "team-1",
      graphChannelId: "channel-1",
      interaction: {
        kind: "submit",
        messageId: "message-1",
        value: { openclawInteractive: { version: 1, data: params.data } },
        ...params.interaction,
      },
    },
    respond: {
      acknowledge: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
      followUp: vi.fn(async () => {}),
      editMessage: vi.fn(async () => {}),
      clearActions: vi.fn(async () => {}),
      deleteMessage: vi.fn(async () => {}),
    },
  };
}

async function expectDedupedInteractiveDispatch(params: {
  baseParams: InteractiveDispatchParams;
  handler: ReturnType<typeof vi.fn>;
  expectedCall: unknown;
}) {
  const first = await dispatchInteractive(params.baseParams);
  const duplicate = await dispatchInteractive(params.baseParams);

  expect(first).toEqual({ matched: true, handled: true, duplicate: false });
  expect(duplicate).toEqual({ matched: true, handled: true, duplicate: true });
  expect(params.handler).toHaveBeenCalledTimes(1);
  expect(params.handler).toHaveBeenCalledWith(expect.objectContaining(params.expectedCall));
}

async function dispatchInteractive(params: InteractiveDispatchParams) {
  if (params.channel === "telegram") {
    return await dispatchPluginInteractiveHandler(params);
  }
  if (params.channel === "discord") {
    return await dispatchPluginInteractiveHandler(params);
  }
  if (params.channel === "slack") {
    return await dispatchPluginInteractiveHandler(params);
  }
  if (params.channel === "msteams") {
    return await dispatchPluginInteractiveHandler(params);
  }
  return await dispatchPluginInteractiveHandler(params);
}

function registerInteractiveHandler(params: {
  channel: "telegram" | "discord" | "slack" | "msteams";
  namespace: string;
  handler: ReturnType<typeof vi.fn>;
}) {
  return registerPluginInteractiveHandler("codex-plugin", {
    channel: params.channel,
    namespace: params.namespace,
    handler: params.handler as never,
  });
}

type BindingHelperCase = {
  name: string;
  registerParams: { channel: "telegram" | "discord" | "slack" | "msteams"; namespace: string };
  dispatchParams: InteractiveDispatchParams;
  requestResult: {
    status: "bound";
    binding: {
      bindingId: string;
      pluginId: string;
      pluginName: string;
      pluginRoot: string;
      channel: string;
      accountId: string;
      conversationId: string;
      parentConversationId?: string;
      threadId?: string | number;
      boundAt: number;
    };
  };
  requestSummary: string;
  expectedConversation: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
    threadId?: string | number;
  };
};

async function expectBindingHelperWiring(params: BindingHelperCase) {
  const currentBinding = {
    ...params.requestResult.binding,
    boundAt: params.requestResult.binding.boundAt + 1,
  };
  requestPluginConversationBindingMock.mockResolvedValueOnce(params.requestResult);
  getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);

  const handler = vi.fn(async (ctx) => {
    await expect(
      ctx.requestConversationBinding({ summary: params.requestSummary }),
    ).resolves.toEqual(params.requestResult);
    await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
    await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
    return { handled: true };
  });

  expect(
    registerPluginInteractiveHandler(
      "codex-plugin",
      {
        ...params.registerParams,
        handler: handler as never,
      },
      { pluginName: "Codex", pluginRoot: "/plugins/codex" },
    ),
  ).toEqual({ ok: true });

  await expect(dispatchInteractive(params.dispatchParams)).resolves.toEqual({
    matched: true,
    handled: true,
    duplicate: false,
  });

  expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
    pluginId: "codex-plugin",
    pluginName: "Codex",
    pluginRoot: "/plugins/codex",
    requestedBySenderId: "user-1",
    conversation: params.expectedConversation,
    binding: {
      summary: params.requestSummary,
    },
  });
  expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
    pluginRoot: "/plugins/codex",
    conversation: params.expectedConversation,
  });
  expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
    pluginRoot: "/plugins/codex",
    conversation: params.expectedConversation,
  });
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

  it.each([
    {
      name: "routes Telegram callbacks by namespace and dedupes callback ids",
      channel: "telegram" as const,
      baseParams: createTelegramDispatchParams({
        data: "codex:resume:thread-1",
        callbackId: "cb-1",
      }),
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
    },
    {
      name: "routes Discord interactions by namespace and dedupes interaction ids",
      channel: "discord" as const,
      baseParams: createDiscordDispatchParams({
        data: "codex:approve:thread-1",
        interactionId: "ix-1",
        interaction: { kind: "button", values: ["allow"] },
      }),
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
    },
    {
      name: "routes Slack interactions by namespace and dedupes interaction ids",
      channel: "slack" as const,
      baseParams: createSlackDispatchParams({
        data: "codex:approve:thread-1",
        interactionId: "slack-ix-1",
        interaction: { kind: "button" },
      }),
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
    },
  ] as const)("$name", async ({ channel, baseParams, expectedCall }) => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(registerInteractiveHandler({ channel, namespace: "codex", handler })).toEqual({
      ok: true,
    });

    await expectDedupedInteractiveDispatch({
      baseParams,
      handler,
      expectedCall,
    });
  });

  it("shares interactive handlers across duplicate module instances", async () => {
    const first = await importInteractiveModule(`first-${Date.now()}`);
    const second = await importInteractiveModule(`second-${Date.now()}`);
    const handler = vi.fn(async () => ({ handled: true }));

    first.clearPluginInteractiveHandlers();

    expect(
      first.registerPluginInteractiveHandler("codex-plugin", {
        channel: "telegram",
        namespace: "codexapp",
        handler,
      }),
    ).toEqual({ ok: true });

    await expect(
      second.dispatchPluginInteractiveHandler(
        createTelegramDispatchParams({
          data: "codexapp:resume:thread-1",
          callbackId: "cb-shared-1",
        }),
      ),
    ).resolves.toEqual({ matched: true, handled: true, duplicate: false });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        callback: expect.objectContaining({
          namespace: "codexapp",
          payload: "resume:thread-1",
        }),
      }),
    );

    second.clearPluginInteractiveHandlers();
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

  it("acknowledges matched Discord interactions before awaiting plugin handlers", async () => {
    const callOrder: string[] = [];
    const handler = vi.fn(async () => {
      callOrder.push("handler");
      expect(callOrder).toEqual(["ack", "handler"]);
      return { handled: true };
    });
    expect(
      registerPluginInteractiveHandler("codex-plugin", {
        channel: "discord",
        namespace: "codex",
        handler,
      }),
    ).toEqual({ ok: true });

    await expect(
      dispatchPluginInteractiveHandler({
        ...createDiscordDispatchParams({
          data: "codex:approve:thread-1",
          interactionId: "ix-ack-1",
          interaction: { kind: "button", values: undefined },
        }),
        onMatched: async () => {
          callOrder.push("ack");
        },
      }),
    ).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
  });

  it("routes Teams interactions by namespace and dedupes interaction ids", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    expect(registerInteractiveHandler({ channel: "msteams", namespace: "codex", handler })).toEqual({
      ok: true,
    });

    await expectDedupedInteractiveDispatch({
      baseParams: createMSTeamsDispatchParams({
        data: "codex:approve:thread-1",
        interactionId: "teams-ix-1",
      }),
      handler,
      expectedCall: {
        channel: "msteams",
        conversationId: "conversation:19:teams@thread.tacv2",
        interaction: expect.objectContaining({
          namespace: "codex",
          payload: "approve:thread-1",
          messageId: "message-1",
        }),
      },
    });
  });

  it.each([
    {
      name: "wires Telegram conversation binding helpers with topic context",
      registerParams: { channel: "telegram", namespace: "codex" },
      dispatchParams: createTelegramDispatchParams({
        data: "codex:bind",
        callbackId: "cb-bind",
      }),
      requestResult: {
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
      },
      requestSummary: "Bind this topic",
      expectedConversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
    },
    {
      name: "wires Discord conversation binding helpers with parent channel context",
      registerParams: { channel: "discord", namespace: "codex" },
      dispatchParams: createDiscordDispatchParams({
        data: "codex:bind",
        interactionId: "ix-bind",
        interaction: { kind: "button", values: ["allow"] },
      }),
      requestResult: {
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
      },
      requestSummary: "Bind Discord",
      expectedConversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
    },
    {
      name: "wires Slack conversation binding helpers with thread context",
      registerParams: { channel: "slack", namespace: "codex" },
      dispatchParams: createSlackDispatchParams({
        data: "codex:bind",
        interactionId: "slack-bind",
        interaction: {
          kind: "button",
          value: "bind",
          selectedValues: ["bind"],
          selectedLabels: ["Bind"],
        },
      }),
      requestResult: {
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
      },
      requestSummary: "Bind Slack",
      expectedConversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
    },
    {
      name: "wires Teams conversation binding helpers with channel context",
      registerParams: { channel: "msteams", namespace: "codex" },
      dispatchParams: createMSTeamsDispatchParams({
        data: "codex:bind",
        interactionId: "teams-bind",
      }),
      requestResult: {
        status: "bound" as const,
        binding: {
          bindingId: "binding-teams",
          pluginId: "codex-plugin",
          pluginName: "Codex",
          pluginRoot: "/plugins/codex",
          channel: "msteams",
          accountId: "default",
          conversationId: "conversation:19:teams@thread.tacv2",
          boundAt: 1,
        },
      },
      requestSummary: "Bind Teams",
      expectedConversation: {
        channel: "msteams",
        accountId: "default",
        conversationId: "conversation:19:teams@thread.tacv2",
      },
    },
  ] as const)("$name", async (testCase) => {
    await expectBindingHelperWiring(testCase);
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

    const baseParams = createTelegramDispatchParams({
      data: "codex:resume:thread-1",
      callbackId: "cb-throw",
    });

    await expect(dispatchPluginInteractiveHandler(baseParams)).rejects.toThrow("boom");
    await expect(dispatchPluginInteractiveHandler(baseParams)).resolves.toEqual({
      matched: true,
      handled: true,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
