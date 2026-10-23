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
  conversationId: "-10099:topic:77",
  parentConversationId: "-10099",
  threadId: 77,
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

    await expect(
      dispatchTelegram("code-agent:7506a349-84c8-4c56-8558-ce315bed2588", "cb-code-agent-restored"),
    ).resolves.toEqual(handled);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      callback: {
        namespace: "code-agent",
        payload: "7506a349-84c8-4c56-8558-ce315bed2588",
      },
    });

    setActivePluginRegistry(createEmptyPluginRegistry());
    await expect(
      dispatchTelegram("code-agent:7506a349-84c8-4c56-8558-ce315bed2588", "cb-code-agent-retired"),
    ).resolves.toEqual({ matched: false, handled: false, duplicate: false });
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

  it("acknowledges matched Discord interactions before awaiting plugin handlers", async () => {
    const callOrder: string[] = [];
    const handler = vi.fn(async () => {
      callOrder.push("handler");
      expect(callOrder).toEqual(["ack", "handler"]);
      return { handled: true };
    });
    register(handler, "discord");

    await expect(
      discordInteractiveDispatcher({
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
    [
      "telegram",
      () => telegramInteractiveDispatcher(telegramParams("codex:bind", "cb-bind")),
      "-10099:topic:77",
      "-10099",
      77,
    ],
    [
      "discord",
      () =>
        discordInteractiveDispatcher(
          interactionParams("discord", "codex:bind", "ix-bind", {
            kind: "button",
            values: ["allow"],
          }),
        ),
      "channel-1",
      "parent-1",
      undefined,
    ],
    [
      "slack",
      () =>
        slackInteractiveDispatcher(
          interactionParams("slack", "codex:bind", "slack-bind", {
            kind: "button",
            value: "bind",
            selectedValues: ["bind"],
            selectedLabels: ["Bind"],
          }),
        ),
      "C123",
      "C123",
      "1710000000.000100",
    ],
  ] as const)(
    "wires %s conversation binding helpers with channel context",
    async (channel, dispatch, conversationId, parentConversationId, threadId) => {
      const conversation = {
        channel,
        accountId: "default",
        conversationId,
        parentConversationId,
        ...(threadId !== undefined ? { threadId } : {}),
      };
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
      await expect(dispatch()).resolves.toEqual(handled);
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

    await expect(telegramInteractiveDispatcher(baseParams)).rejects.toThrow("post-handler failure");
    await expect(telegramInteractiveDispatcher(baseParams)).resolves.toEqual(handled);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(afterInvoke).toHaveBeenCalledTimes(2);
    expect(afterInvoke).toHaveBeenLastCalledWith({ handled: true });
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
