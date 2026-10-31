import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelConversationBindingSupport } from "../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { buildSessionCommandTestParams } from "./commands-session-params.test-support.js";
import { handleSessionCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
type ResolveCommandConversationParams = {
  threadId?: string;
  threadParentId?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
};

function resolveCommandConversation(params: ResolveCommandConversationParams, room = false) {
  const target = (raw?: string) =>
    raw
      ?.trim()
      .replace(room ? /^room-chat:/i : /^thread-chat:/i, "")
      .replace(room ? /^(room|channel):/i : /^channel:/i, "")
      .trim();
  const parentConversationId = [
    room ? undefined : target(params.threadParentId),
    target(params.originatingTo),
    target(params.commandTo),
    target(params.fallbackTo),
  ].find(Boolean);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

const hoisted = vi.hoisted(() => {
  const setThreadIdle = vi.fn();
  const setThreadMaxAge = vi.fn();
  const setRoomIdle = vi.fn();
  const setRoomMaxAge = vi.fn();
  const resolveBinding = vi.fn();
  const unbind = vi.fn();
  const registry = {
    channels: (
      [
        ["thread-chat", setThreadIdle, setThreadMaxAge],
        ["room-chat", setRoomIdle, setRoomMaxAge],
      ] as const
    ).map(([id, setIdleTimeoutBySessionKey, setMaxAgeBySessionKey]) => {
      const conversationBindings: ChannelConversationBindingSupport = {
        supportsCurrentConversationBinding: true,
        setIdleTimeoutBySessionKey,
        setMaxAgeBySessionKey,
      };
      return {
        plugin: {
          id,
          meta: {},
          config: { hasPersistedAuthState: () => false },
          bindings: {
            resolveCommandConversation: (params: ResolveCommandConversationParams) =>
              resolveCommandConversation(params, id === "room-chat"),
          },
          conversationBindings,
        },
      };
    }),
  };
  return {
    setThreadIdle,
    setThreadMaxAge,
    setRoomIdle,
    setRoomMaxAge,
    resolveBinding,
    unbind,
    registry,
  };
});

// mock-isolation: Keep lifecycle resolution on this fixture's registry, not process-global plugins.
vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.registry,
  requireActivePluginRegistry: () => hoisted.registry,
  getActivePluginChannelRegistry: () => hoisted.registry,
  requireActivePluginChannelRegistry: () => hoisted.registry,
  getActivePluginRegistryVersion: () => 1,
  getActivePluginChannelRegistryVersion: () => 1,
}));
// mock-isolation: Resolve only the fixture channels without loading bundled channel runtimes.
vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.registry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  getLoadedChannelPlugin: (channelId: string) =>
    hoisted.registry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  normalizeChannelId: (raw?: string | null) => raw?.trim().toLowerCase() || null,
}));
// mock-isolation: Registry lookups must observe the same fixture-owned channel instances.
vi.mock("../../channels/plugins/registry.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.registry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
}));
// mock-isolation: Observe binding effects without opening the live outbound binding store.
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    resolveByConversationAsync: async (ref: unknown) => hoisted.resolveBinding(ref),
    unbind: hoisted.unbind,
  }),
}));

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;
function commandParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const ctx = {
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "quietchat",
    Surface: "quietchat",
    To: "+1222",
    SenderId: "user-1",
    ...ctxOverrides,
  } as HandleCommandsParams["ctx"];
  const channel = normalizeLowercaseStringOrEmpty(ctx.Provider ?? ctx.Surface);
  const senderId = typeof ctx.SenderId === "string" ? ctx.SenderId : undefined;
  return buildSessionCommandTestParams(
    {
      surface: normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider),
      channel,
      channelId: channel,
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId,
      abortKey: senderId,
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim().toLowerCase(),
      to: typeof ctx.To === "string" ? ctx.To : undefined,
    },
    {
      ctx,
      cfg: baseCfg,
      directives: parseInlineSessionDirectives(commandBody),
      provider: channel,
      model: "test-model",
    },
  );
}

function channelCommandParams(
  commandBody: string,
  channel: string,
  threadId?: string,
  overrides?: Record<string, unknown>,
) {
  return commandParams(commandBody, {
    Provider: channel,
    Surface: channel,
    OriginatingChannel: channel,
    OriginatingTo: channel === THREAD_CHANNEL ? "channel:thread-1" : "room:!room:example.org",
    AccountId: "default",
    ...(threadId ? { MessageThreadId: threadId } : {}),
    ...overrides,
  });
}

const threadParams = (body: string, overrides?: Record<string, unknown>) =>
  channelCommandParams(body, THREAD_CHANNEL, "thread-1", overrides);
const roomThreadParams = (body: string) => channelCommandParams(body, ROOM_CHANNEL, "$thread-1");
const rootParams = (body: string) => channelCommandParams(body, ROOM_CHANNEL, "$root");
const roomParams = (body: string) => channelCommandParams(body, ROOM_CHANNEL);

function createLifecycleBinding(
  conversation: SessionBindingRecord["conversation"],
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return {
    bindingId: `default:${conversation.conversationId}`,
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    conversation,
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      lastActivityAt: Date.now(),
      idleTimeoutMs: 24 * 60 * 60 * 1000,
      maxAgeMs: 0,
    },
    ...overrides,
  };
}

function bindingFor(channel: string, conversationId: string) {
  return (overrides?: Partial<SessionBindingRecord>) =>
    createLifecycleBinding(
      {
        channel,
        accountId: "default",
        conversationId,
        parentConversationId: channel === THREAD_CHANNEL ? "thread-1" : "!room:example.org",
      },
      overrides,
    );
}
const threadBinding = bindingFor(THREAD_CHANNEL, "thread-1");
const roomBinding = bindingFor(ROOM_CHANNEL, "$thread-1");
const rootBinding = bindingFor(ROOM_CHANNEL, "$root");
const lifecycleUpdates = [
  hoisted.setThreadIdle,
  hoisted.setThreadMaxAge,
  hoisted.setRoomIdle,
  hoisted.setRoomMaxAge,
];
const now = Date.parse("2026-02-20T00:00:00.000Z");
const hour = 60 * 60 * 1000;

function freezeTime() {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

describe("/session conversation bindings", () => {
  beforeEach(() => {
    for (const mock of lifecycleUpdates) {
      mock.mockReset();
    }
    hoisted.resolveBinding.mockReset().mockReturnValue(null);
    hoisted.unbind.mockReset().mockResolvedValue([]);
    for (const { plugin } of hoisted.registry.channels) {
      delete plugin.conversationBindings.setIdleTimeoutBySessionKeyAsync;
      delete plugin.conversationBindings.setMaxAgeBySessionKeyAsync;
    }
    vi.useRealTimers();
  });

  it.each([
    { name: "thread", createParams: threadParams, createBinding: threadBinding },
    {
      name: "triggering thread",
      createParams: rootParams,
      createBinding: rootBinding,
    },
    {
      name: "generic conversation without lifecycle support",
      createParams: (body: string) =>
        channelCommandParams(body, "webchat", undefined, { OriginatingTo: "chat-1" }),
      createBinding: () =>
        createLifecycleBinding({
          channel: "webchat",
          accountId: "default",
          conversationId: "chat-1",
        }),
    },
  ])("unbinds only the current $name conversation", async ({ createParams, createBinding }) => {
    const binding = createBinding();
    hoisted.resolveBinding.mockReturnValue(binding);
    hoisted.unbind.mockResolvedValue([binding]);
    const result = await handleSessionCommand(createParams("/session unbind"), true);
    expect(result?.reply?.text).toBe("✅ Conversation unbound.");
    expect(hoisted.unbind).toHaveBeenCalledExactlyOnceWith({
      bindingId: binding.bindingId,
      scope: binding.conversation,
      reason: "manual",
    });
  });

  it("reports an unbind that removed no binding", async () => {
    hoisted.resolveBinding.mockReturnValue(threadBinding());
    const result = await handleSessionCommand(threadParams("/session unbind"), true);
    expect(result?.reply?.text).toBe(
      "⚠️ No binding was removed; this conversation may still be bound.",
    );
    expect(hoisted.unbind).toHaveBeenCalledOnce();
  });

  it.each([
    ["unbind", "user-1", "Only user-1 can unbind this conversation."],
    ["idle 2h", "owner-1", "Only owner-1 can update session lifecycle settings"],
  ])("requires the binding owner for %s", async (action, boundBy, message) => {
    const binding = threadBinding();
    binding.metadata = { ...binding.metadata, boundBy };
    hoisted.resolveBinding.mockReturnValue(binding);
    const result = await handleSessionCommand(
      threadParams(`/session ${action}`, { SenderId: "other-user" }),
      true,
    );
    expect(result?.reply?.text).toContain(message);
    expect(hoisted.unbind).not.toHaveBeenCalled();
    expect(hoisted.setThreadIdle).not.toHaveBeenCalled();
  });

  it.each(["unbind all", "idle 9999999999999"])("rejects invalid /session %s", async (action) => {
    hoisted.resolveBinding.mockReturnValue(threadBinding());
    const result = await handleSessionCommand(threadParams(`/session ${action}`), true);
    expect(result?.reply?.text).toBe(
      "Usage: /session idle <duration|off> | /session max-age <duration|off> | /session unbind (example: /session idle 24h)",
    );
    expect(hoisted.unbind).not.toHaveBeenCalled();
    expect(hoisted.setThreadIdle).not.toHaveBeenCalled();
  });

  it.each([
    {
      action: "idle",
      value: "2h",
      durationMs: 2 * 60 * 60 * 1000,
      durationKey: "idleTimeoutMs",
      label: "Idle timeout set to 2h",
      expiry: "2026-02-20T02:00:00.000Z",
      boundAgeMs: 0,
      createParams: rootParams,
      createBinding: rootBinding,
      update: hoisted.setRoomIdle,
    },
    {
      action: "max-age",
      value: "3h",
      durationMs: 3 * 60 * 60 * 1000,
      durationKey: "maxAgeMs",
      label: "Max age set to 3h",
      expiry: "2026-02-20T01:00:00.000Z",
      boundAgeMs: 2 * 60 * 60 * 1000,
      createParams: roomThreadParams,
      createBinding: roomBinding,
      update: hoisted.setRoomMaxAge,
    },
    {
      action: "max-age",
      value: "off",
      durationMs: 0,
      durationKey: "maxAgeMs",
      label: "Max age disabled",
      expiry: undefined,
      boundAgeMs: 0,
      createParams: threadParams,
      createBinding: threadBinding,
      update: hoisted.setThreadMaxAge,
    },
  ])("sets /session $action $value using the binding lifecycle", async (scenario) => {
    freezeTime();
    const binding = scenario.createBinding({ boundAt: Date.now() - scenario.boundAgeMs });
    if (scenario.value === "off") {
      binding.metadata = { ...binding.metadata, maxAgeMs: 2 * 60 * 60 * 1000 };
    }
    hoisted.resolveBinding.mockReturnValue(binding);
    scenario.update.mockReturnValue([
      {
        targetSessionKey: binding.targetSessionKey,
        boundAt: binding.boundAt,
        lastActivityAt: Date.now(),
        [scenario.durationKey]: scenario.durationMs,
      },
    ]);
    const result = await handleSessionCommand(
      scenario.createParams(`/session ${scenario.action} ${scenario.value}`),
      true,
    );
    if (scenario.action === "idle") {
      expect(hoisted.resolveBinding).toHaveBeenCalledWith({
        channel: ROOM_CHANNEL,
        accountId: "default",
        conversationId: "$root",
        parentConversationId: "!room:example.org",
        threadId: "$root",
      });
    }
    expect(scenario.update).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "default",
      [scenario.durationKey]: scenario.durationMs,
    });
    expect(result?.reply?.text).toContain(scenario.label);
    if (scenario.expiry) {
      expect(result?.reply?.text).toContain(scenario.expiry);
    }
  });

  it.each([
    ["active", now, 2 * hour],
    ["out-of-range activity", 8_700_000_000_000_000, 2 * hour],
    ["overflowed timeout", now, Number.MAX_SAFE_INTEGER],
  ] as const)("reports %s idle timeout metadata", async (_name, lastActivityAt, idleTimeoutMs) => {
    freezeTime();
    hoisted.resolveBinding.mockReturnValue(
      threadBinding({
        metadata: { boundBy: "user-1", lastActivityAt, idleTimeoutMs, maxAgeMs: 0 },
      }),
    );
    const result = await handleSessionCommand(threadParams("/session idle"), true);
    if (idleTimeoutMs === Number.MAX_SAFE_INTEGER) {
      expect(result?.reply?.text).toBe(
        "ℹ️ Idle timeout is currently disabled for this bound session.",
      );
    } else {
      expect(result?.reply?.text).toContain("Idle timeout active (2h");
      expect(result?.reply?.text).toContain("2026-02-20T02:00:00.000Z");
    }
  });

  it("does not mutate a binding after cancellation during lookup", async () => {
    const lookup = createDeferred<SessionBindingRecord>();
    const started = createDeferred();
    const controller = new AbortController();
    const reason = new Error("command canceled during binding lookup");
    hoisted.resolveBinding.mockImplementationOnce(() => {
      started.resolve();
      return lookup.promise;
    });
    const params = threadParams("/session idle off");
    params.opts = { abortSignal: controller.signal };
    const result = handleSessionCommand(params, true);
    const failure = expect(result).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    lookup.resolve(threadBinding());
    await failure;
    expect(hoisted.setThreadIdle).not.toHaveBeenCalled();
    expect(hoisted.setThreadMaxAge).not.toHaveBeenCalled();
    expect(hoisted.unbind).not.toHaveBeenCalled();
  });

  it.each([
    { action: "idle", method: "setIdleTimeoutBySessionKeyAsync", outcome: "success" },
    { action: "max-age", method: "setMaxAgeBySessionKeyAsync", outcome: "success" },
    { action: "idle", method: "setIdleTimeoutBySessionKeyAsync", outcome: "failure" },
    { action: "max-age", method: "setMaxAgeBySessionKeyAsync", outcome: "failure" },
  ] as const)(
    "settles $action persistence before reporting $outcome",
    async ({ action, method, outcome }) => {
      const mutation = createDeferred<Array<{ boundAt: number; lastActivityAt: number }>>();
      const started = createDeferred();
      hoisted.registry.channels[0]!.plugin.conversationBindings[method] = () => {
        started.resolve();
        return mutation.promise;
      };
      hoisted.resolveBinding.mockReturnValue(threadBinding());
      let settled = false;
      const result = handleSessionCommand(threadParams(`/session ${action} off`), true);
      const onSettled = () => {
        settled = true;
      };
      void result.then(onSettled, onSettled);
      const failure =
        outcome === "failure"
          ? expect(result).rejects.toThrow("binding persistence failed")
          : undefined;
      await started.promise;
      expect(settled).toBe(false);
      if (outcome === "failure") {
        mutation.reject(new Error("binding persistence failed"));
        await failure;
      } else {
        mutation.resolve([{ boundAt: 1, lastActivityAt: 1 }]);
        expect((await result)?.reply?.text).toContain(
          action === "idle" ? "Idle timeout disabled" : "Max age disabled",
        );
        expect(hoisted.setThreadIdle).not.toHaveBeenCalled();
        expect(hoisted.setThreadMaxAge).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      name: "channels without lifecycle support",
      createParams: commandParams,
      message:
        "currently available only on channels that support conversation binding lifecycle updates",
    },
    {
      name: "unbound room-chat threads",
      createParams: roomParams,
      message: "This conversation is not currently bound.",
    },
  ])("rejects lifecycle updates for $name", async ({ createParams, message }) => {
    const result = await handleSessionCommand(createParams("/session idle 2h"), true);
    expect(result?.reply?.text).toContain(message);
    expect(hoisted.setRoomIdle).not.toHaveBeenCalled();
  });
});
