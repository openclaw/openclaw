import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as conversationBinding from "./conversation-binding.js";
import type {
  DiscordInteractiveHandlerContext,
  SlackInteractiveHandlerContext,
  TelegramInteractiveHandlerContext,
} from "./interactive-contract.test-helpers.js";
import {
  clearPluginInteractiveHandlers,
  createChannelInteractiveDispatcher,
  registerPluginInteractiveHandler,
} from "./interactive.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "./runtime.js";

let requestPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.requestPluginConversationBinding
>;
let detachPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.detachPluginConversationBinding
>;
let getCurrentPluginConversationBindingMock: MockInstance<
  typeof conversationBinding.getCurrentPluginConversationBinding
>;

const telegramInteractiveDispatcher = createChannelInteractiveDispatcher<
  "telegram",
  "callback",
  TelegramInteractiveHandlerContext,
  { handled?: boolean } | void,
  "callbackMessage"
>({ channel: "telegram", interactiveKey: "callback", dispatchInteractiveKey: "callbackMessage" });
const discordInteractiveDispatcher = createChannelInteractiveDispatcher<
  "discord",
  "interaction",
  DiscordInteractiveHandlerContext
>({ channel: "discord", interactiveKey: "interaction" });
const slackInteractiveDispatcher = createChannelInteractiveDispatcher<
  "slack",
  "interaction",
  SlackInteractiveHandlerContext
>({ channel: "slack", interactiveKey: "interaction" });

type InteractiveDispatchParams =
  | (Parameters<typeof telegramInteractiveDispatcher>[0] & { channel: "telegram" })
  | (Parameters<typeof discordInteractiveDispatcher>[0] & { channel: "discord" })
  | (Parameters<typeof slackInteractiveDispatcher>[0] & { channel: "slack" });

const conversations = {
  telegram: { conversationId: "-10099:topic:77", parentConversationId: "-10099", threadId: 77 },
  discord: { conversationId: "channel-1", parentConversationId: "parent-1" },
  slack: { conversationId: "C123", parentConversationId: "C123", threadId: "1710000000.000100" },
};

function baseDispatchParams<TChannel extends keyof typeof conversations>(
  channel: TChannel,
  data: string,
  id: string,
) {
  return {
    channel,
    data,
    dedupeId: id,
    respond: {},
    ctx: {
      ...conversations[channel],
      accountId: "default",
      senderId: "user-1",
      auth: { isAuthorizedSender: true },
    },
  };
}

function telegramParams(
  data: string,
  callbackId: string,
): Extract<InteractiveDispatchParams, { channel: "telegram" }> {
  const base = baseDispatchParams("telegram", data, callbackId);
  return {
    ...base,
    ctx: { ...base.ctx, callbackId, callbackMessage: { messageId: 55, chatId: "-10099" } },
  };
}

function interactionParams<TChannel extends "discord" | "slack">(
  channel: TChannel,
  data: string,
  interactionId: string,
  interaction: Record<string, unknown>,
) {
  const base = baseDispatchParams(channel, data, interactionId);
  return { ...base, ctx: { ...base.ctx, interactionId, interaction } };
}

async function dispatchInteractive(params: InteractiveDispatchParams) {
  if (params.channel === "telegram") {
    return await telegramInteractiveDispatcher(params);
  }
  if (params.channel === "discord") {
    return await discordInteractiveDispatcher(params);
  }
  return await slackInteractiveDispatcher(params);
}

function requireHandlerCall(handler: ReturnType<typeof vi.fn>, index = 0): unknown {
  const call = handler.mock.calls[index] as [unknown] | undefined;
  if (!call) {
    throw new Error(`handler call ${index} missing`);
  }
  return call[0];
}

const binding = {
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
};
const boundFixtureResult = { status: "bound" as const, binding };
const handled = { matched: true, handled: true, duplicate: false };
const duplicate = { ...handled, duplicate: true };

function register(
  handler: Parameters<typeof registerPluginInteractiveHandler>[1]["handler"],
  channel = "telegram",
  namespace = "codex",
  metadata?: Parameters<typeof registerPluginInteractiveHandler>[2],
) {
  const result = registerPluginInteractiveHandler(
    "codex-plugin",
    { channel, namespace, handler },
    metadata,
  );
  expect(result).toEqual({ ok: true });
}

function dispatchTelegram(data: string, callbackId: string) {
  return dispatchInteractive(telegramParams(data, callbackId));
}

describe("plugin interactive handlers", () => {
  beforeEach(() => {
    clearPluginInteractiveHandlers();
    requestPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "requestPluginConversationBinding")
      .mockResolvedValue(boundFixtureResult);
    detachPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "detachPluginConversationBinding")
      .mockResolvedValue({ removed: true });
    getCurrentPluginConversationBindingMock = vi
      .spyOn(conversationBinding, "getCurrentPluginConversationBinding")
      .mockResolvedValue(binding);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
  });

  it("writes direct registrations into the synchronous builder context", () => {
    const active = createEmptyPluginRegistry();
    const building = createEmptyPluginRegistry();
    setActivePluginRegistry(active);

    expect(
      withPluginRegistrationContext(building, "codex-plugin", () =>
        registerPluginInteractiveHandler("spoofed-plugin", {
          channel: "telegram",
          namespace: "builder",
          handler: async () => ({ handled: true }),
        }),
      ),
    ).toEqual({ ok: true });
    expect(active.interactiveHandlers).toStrictEqual([]);
    expect(building.interactiveHandlers.map((entry) => entry.namespace)).toEqual(["builder"]);
    expect(building.interactiveHandlers[0]?.pluginId).toBe("codex-plugin");
  });

  it("hydrates legacy interactive state shapes before clearing handlers", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const stateKey = Symbol.for("openclaw.pluginInteractiveState");
    const originalState = globalStore[stateKey];

    globalStore[stateKey] = {
      interactiveHandlers: new Map(),
    };

    try {
      clearPluginInteractiveHandlers();
      const hydrated = globalStore[stateKey] as {
        interactiveHandlers?: Map<string, unknown>;
        callbackDedupe?: { clear: () => void };
        inflightCallbackDedupe?: Set<string>;
      };
      expect(hydrated.interactiveHandlers).toBeUndefined();
      if (!hydrated.callbackDedupe) {
        throw new Error("expected hydrated callback dedupe");
      }
      hydrated.callbackDedupe.clear();
      expect(hydrated.inflightCallbackDedupe).toBeInstanceOf(Set);

      const handler = vi.fn(async () => ({ handled: true }));
      register(handler, "telegram", "legacy");
      await expect(dispatchTelegram("legacy:resume", "legacy-state-cb")).resolves.toEqual(handled);
      await expect(dispatchTelegram("legacy:resume", "legacy-state-cb")).resolves.toEqual(
        duplicate,
      );
    } finally {
      if (originalState === undefined) {
        delete globalStore[stateKey];
      } else {
        globalStore[stateKey] = originalState;
      }
      clearPluginInteractiveHandlers();
    }
  });

  it("resolves active registry handlers without retaining them after retirement", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "openclaw-code-agent",
      name: "OpenClaw Code Agent",
      status: "loaded",
    } as never);
    registry.interactiveHandlers = [
      {
        channel: "telegram",
        namespace: "code-agent",
        pluginId: "openclaw-code-agent",
        pluginName: "OpenClaw Code Agent",
        pluginRoot: "/plugins/openclaw-code-agent",
        handler: handler as never,
      },
    ];
    expect(
      registerPluginInteractiveHandler(
        "openclaw-code-agent",
        {
          channel: "telegram",
          namespace: "code-agent",
          handler: handler as never,
        },
        {
          pluginName: "OpenClaw Code Agent",
          pluginRoot: "/plugins/openclaw-code-agent",
        },
      ),
    ).toEqual({ ok: true });
    setActivePluginRegistry(registry);

    await expect(
      dispatchTelegram("code-agent:7506a349-84c8-4c56-8558-ce315bed2588", "cb-code-agent-restored"),
    ).resolves.toEqual(handled);

    expect(handler).toHaveBeenCalledTimes(1);
    const ctx = requireHandlerCall(handler) as TelegramInteractiveHandlerContext;
    expect(ctx.callback).toMatchObject({
      namespace: "code-agent",
      payload: "7506a349-84c8-4c56-8558-ce315bed2588",
    });

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      dispatchTelegram("code-agent:7506a349-84c8-4c56-8558-ce315bed2588", "cb-code-agent-retired"),
    ).resolves.toEqual({ matched: false, handled: false, duplicate: false });
    expect(handler).toHaveBeenCalledTimes(1);
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
    register(handler, "discord");

    await expect(
      dispatchInteractive({
        ...interactionParams("discord", "codex:approve:thread-1", "ix-ack-1", {
          kind: "button",
          values: undefined,
        }),
        onMatched: async () => {
          callOrder.push("ack");
        },
      }),
    ).resolves.toEqual(handled);
  });

  it.each([
    {
      channel: "telegram" as const,
      dispatchParams: telegramParams("codex:bind", "cb-bind"),
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-10099:topic:77",
        parentConversationId: "-10099",
        threadId: 77,
      },
    },
    {
      channel: "discord" as const,
      dispatchParams: interactionParams("discord", "codex:bind", "ix-bind", {
        kind: "button",
        values: ["allow"],
      }),
      conversation: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel-1",
        parentConversationId: "parent-1",
      },
    },
    {
      channel: "slack" as const,
      dispatchParams: interactionParams("slack", "codex:bind", "slack-bind", {
        kind: "button",
        value: "bind",
        selectedValues: ["bind"],
        selectedLabels: ["Bind"],
      }),
      conversation: {
        channel: "slack",
        accountId: "default",
        conversationId: "C123",
        parentConversationId: "C123",
        threadId: "1710000000.000100",
      },
    },
  ])(
    "wires $channel conversation binding helpers with channel context",
    async ({ channel, dispatchParams, conversation }) => {
      const requestResult = {
        status: "bound" as const,
        binding: {
          ...conversation,
          bindingId: binding.bindingId,
          pluginId: binding.pluginId,
          pluginName: binding.pluginName,
          pluginRoot: binding.pluginRoot,
          boundAt: binding.boundAt,
        },
      };
      const currentBinding = { ...requestResult.binding, boundAt: 2 };
      requestPluginConversationBindingMock.mockResolvedValueOnce(requestResult);
      getCurrentPluginConversationBindingMock.mockResolvedValueOnce(currentBinding);
      const handler = vi.fn(
        async (
          ctx:
            | TelegramInteractiveHandlerContext
            | DiscordInteractiveHandlerContext
            | SlackInteractiveHandlerContext,
        ) => {
          await expect(
            ctx.requestConversationBinding({ summary: "Bind this topic" }),
          ).resolves.toEqual(requestResult);
          await expect(ctx.detachConversationBinding()).resolves.toEqual({ removed: true });
          await expect(ctx.getCurrentConversationBinding()).resolves.toEqual(currentBinding);
          return { handled: true };
        },
      );
      register(handler as never, channel, "codex", {
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
      });
      await expect(dispatchInteractive(dispatchParams)).resolves.toEqual(handled);
      expect(requestPluginConversationBindingMock).toHaveBeenCalledWith({
        pluginId: "codex-plugin",
        pluginName: "Codex",
        pluginRoot: "/plugins/codex",
        requestedBySenderId: "user-1",
        conversation,
        binding: { summary: "Bind this topic" },
      });
      expect(detachPluginConversationBindingMock).toHaveBeenCalledWith({
        pluginRoot: "/plugins/codex",
        conversation,
      });
      expect(getCurrentPluginConversationBindingMock).toHaveBeenCalledWith({
        pluginRoot: "/plugins/codex",
        conversation,
      });
    },
  );

  it.each([
    ["authorized and bound", { expectedStatus: "bound" }],
    ["unauthorized", { auth: false }],
    ["missing sender", { senderId: " " }],
    ["missing account", { accountId: " " }],
    [
      "missing base conversation despite an override",
      {
        conversationId: " ",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "override-conversation",
        },
      },
    ],
  ] as const)("exposes binding authority only when %s", async (name, overrides) => {
    const testCase = {
      auth: true,
      senderId: "user-1",
      accountId: "default",
      conversationId: "conversation-1",
      conversation: undefined,
      expectedStatus: "error",
      ...overrides,
    };
    let bindingResult: unknown;
    const handler = vi.fn(async (ctx: TelegramInteractiveHandlerContext) => {
      bindingResult = await ctx.requestConversationBinding();
    });
    register(handler as never, "telegram", "codex", {
      pluginName: "Codex",
      pluginRoot: "/plugins/codex",
    });
    const params = telegramParams("codex:bind", `auth-${name}`);

    await dispatchInteractive({
      ...params,
      conversation: testCase.conversation,
      ctx: {
        ...params.ctx,
        auth: { isAuthorizedSender: testCase.auth },
        senderId: testCase.senderId,
        accountId: testCase.accountId,
        conversationId: testCase.conversationId,
      },
    });

    expect(bindingResult).toMatchObject({ status: testCase.expectedStatus });
    expect(requestPluginConversationBindingMock).toHaveBeenCalledTimes(
      testCase.expectedStatus === "bound" ? 1 : 0,
    );
  });

  it("does not consume dedupe keys when post-handler processing throws", async () => {
    const handler = vi.fn(async () => ({ handled: true }));
    const afterInvoke = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error("post-handler failure"))
      .mockResolvedValueOnce(undefined);
    register(handler);

    const baseParams = {
      ...telegramParams("codex:resume:thread-1", "cb-post-handler-failure"),
      afterInvoke,
    };

    await expect(dispatchInteractive(baseParams)).rejects.toThrow("post-handler failure");
    await expect(dispatchInteractive(baseParams)).resolves.toEqual(handled);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(afterInvoke).toHaveBeenCalledTimes(2);
    expect(afterInvoke).toHaveBeenLastCalledWith({ handled: true });
  });

  it("dedupes concurrent interactive dispatches while a handler is still running", async () => {
    const { promise: handlerGate, resolve: releaseHandler } = Promise.withResolvers<void>();
    const handler = vi.fn(async () => {
      await handlerGate;
      return { handled: true };
    });
    register(handler);

    const baseParams = telegramParams("codex:resume:thread-1", "cb-concurrent");

    const firstDispatch = dispatchInteractive(baseParams);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });
    const duplicateDispatch = await dispatchInteractive(baseParams);

    expect(duplicateDispatch).toEqual(duplicate);

    releaseHandler();

    await expect(firstDispatch).resolves.toEqual(handled);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("releases inflight interactive dedupe keys after a handler failure", async () => {
    const { promise: handlerGate, reject: rejectHandler } = Promise.withResolvers<never>();
    const handler = vi
      .fn(async () => ({ handled: true }))
      .mockImplementationOnce(async () => await handlerGate)
      .mockResolvedValueOnce({ handled: true });
    register(handler);

    const baseParams = telegramParams("codex:resume:thread-1", "cb-retry-after-failure");

    const firstDispatch = dispatchInteractive(baseParams);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    await expect(dispatchInteractive(baseParams)).resolves.toEqual(duplicate);

    rejectHandler(new Error("boom"));
    await expect(firstDispatch).rejects.toThrow("boom");

    await expect(dispatchInteractive(baseParams)).resolves.toEqual(handled);
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
