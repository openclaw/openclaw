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

function telegramParams(data: string, callbackId: string) {
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

const bindingMetadata = {
  bindingId: "binding-1",
  pluginId: "codex-plugin",
  pluginName: "Codex",
  pluginRoot: "/plugins/codex",
  boundAt: 1,
};
const binding = {
  ...bindingMetadata,
  channel: "telegram",
  accountId: "default",
  ...conversations.telegram,
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
  return telegramInteractiveDispatcher(telegramParams(data, callbackId));
}

function dispatchBinding(channel: keyof typeof conversations, onMatched: () => void) {
  switch (channel) {
    case "telegram":
      return telegramInteractiveDispatcher({
        ...telegramParams("codex:bind", "cb-bind"),
        onMatched,
      });
    case "discord":
      return discordInteractiveDispatcher({
        ...interactionParams(channel, "codex:bind", "ix-bind", {
          kind: "button",
          values: ["allow"],
        }),
        onMatched,
      });
    default:
      return slackInteractiveDispatcher({
        ...interactionParams(channel, "codex:bind", "slack-bind", {
          kind: "button",
          value: "bind",
          selectedValues: ["bind"],
          selectedLabels: ["Bind"],
        }),
        onMatched,
      });
  }
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
    expect(building.interactiveHandlers).toMatchObject([
      { namespace: "builder", pluginId: "codex-plugin" },
    ]);
  });

  it("hydrates legacy interactive state shapes before clearing handlers", async () => {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    const stateKey = Symbol.for("openclaw.pluginInteractiveState");
    const originalState = globalStore[stateKey];

    globalStore[stateKey] = { interactiveHandlers: new Map() };
    try {
      clearPluginInteractiveHandlers();
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
    const handler = vi.fn(async (_ctx: unknown) => ({ handled: true }));
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({
      id: "openclaw-code-agent",
      name: "OpenClaw Code Agent",
      status: "loaded",
    } as never);
    const registration = { channel: "telegram", namespace: "code-agent", handler };
    const metadata = {
      pluginName: "OpenClaw Code Agent",
      pluginRoot: "/plugins/openclaw-code-agent",
    };
    registry.interactiveHandlers = [
      { ...registration, ...metadata, pluginId: "openclaw-code-agent" },
    ];
    expect(registerPluginInteractiveHandler("openclaw-code-agent", registration, metadata)).toEqual(
      { ok: true },
    );
    setActivePluginRegistry(registry);

    const data = "code-agent:7506a349-84c8-4c56-8558-ce315bed2588";
    await expect(dispatchTelegram(data, "cb-code-agent-restored")).resolves.toEqual(handled);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      callback: {
        namespace: "code-agent",
        payload: "7506a349-84c8-4c56-8558-ce315bed2588",
      },
    });

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(dispatchTelegram(data, "cb-code-agent-retired")).resolves.toEqual({
      matched: false,
      handled: false,
      duplicate: false,
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate namespace registrations", () => {
    const registration = {
      channel: "telegram",
      namespace: "codex",
      handler: async () => ({ handled: true }),
    };
    const [first, second] = ["plugin-a", "plugin-b"].map((id) =>
      registerPluginInteractiveHandler(id, registration),
    );
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({
      ok: false,
      error: 'Interactive handler namespace "codex" already registered by plugin "plugin-a"',
    });
  });

  it.each(["telegram", "discord", "slack"] as const)(
    "wires %s conversation binding helpers with channel context",
    async (channel) => {
      const callOrder: string[] = [];
      const conversation = { channel, accountId: "default", ...conversations[channel] };
      const requestResult = {
        status: "bound" as const,
        binding: { ...bindingMetadata, ...conversation },
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
          callOrder.push("handler");
          expect(callOrder).toEqual(["ack", "handler"]);
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
      await expect(
        dispatchBinding(channel, () => {
          callOrder.push("ack");
        }),
      ).resolves.toEqual(handled);
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

    await telegramInteractiveDispatcher({
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

    expect(bindingResult).toMatchObject({ status: "error" });
    expect(requestPluginConversationBindingMock).not.toHaveBeenCalled();
  });

  it.each([false, true])("settles concurrent dedupe claims (handler fails=%s)", async (fails) => {
    const gate = Promise.withResolvers<void>();
    const handler = vi
      .fn(async () => ({ handled: true }))
      .mockImplementationOnce(async () => {
        await gate.promise;
        return { handled: true };
      });
    register(handler);

    const baseParams = telegramParams("codex:resume:thread-1", "cb-concurrent");

    const firstDispatch = telegramInteractiveDispatcher(baseParams);
    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
    });

    await expect(telegramInteractiveDispatcher(baseParams)).resolves.toEqual(duplicate);

    if (fails) {
      gate.reject(new Error("boom"));
      await expect(firstDispatch).rejects.toThrow("boom");
      await expect(telegramInteractiveDispatcher(baseParams)).resolves.toEqual(handled);
    } else {
      gate.resolve();
      await expect(firstDispatch).resolves.toEqual(handled);
    }
    expect(handler).toHaveBeenCalledTimes(fails ? 2 : 1);
  });
});
