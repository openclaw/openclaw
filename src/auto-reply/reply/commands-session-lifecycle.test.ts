// Tests conversation binding lifecycle updates and non-destructive detach.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { ChannelConversationBindingSupport } from "../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { handleSessionCommand } from "./commands-session.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";

type ResolveCommandConversationParams = {
  threadId?: string;
  threadParentId?: string;
  parentSessionKey?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
};

function firstText(values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim() ?? "").find(Boolean) || undefined;
}

function normalizeCommandContextText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim().toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value).trim().toLowerCase();
  }
  return "";
}

function resolveThreadTargetId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^thread-chat:/i, "")
    .replace(/^channel:/i, "")
    .trim();
}

function resolveThreadCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveThreadTargetId(params.threadParentId),
    resolveThreadTargetId(params.originatingTo),
    resolveThreadTargetId(params.commandTo),
    resolveThreadTargetId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveRoomId(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^room-chat:/i, "")
    .replace(/^(room|channel):/i, "")
    .trim();
}

function resolveRoomCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    resolveRoomId(params.originatingTo),
    resolveRoomId(params.commandTo),
    resolveRoomId(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

const hoisted = vi.hoisted(() => {
  const threadChannel = "thread-chat";
  const roomChannel = "room-chat";
  const setThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingIdleTimeoutBySessionKeyMock = vi.fn();
  const setMatrixThreadBindingMaxAgeBySessionKeyMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  function createRuntimeChannel(
    id: string,
    resolveCommandConversation: (params: ResolveCommandConversationParams) => {
      conversationId: string;
      parentConversationId?: string;
    } | null,
    setIdleTimeoutBySessionKey: typeof setThreadBindingIdleTimeoutBySessionKeyMock,
    setMaxAgeBySessionKey: typeof setThreadBindingMaxAgeBySessionKeyMock,
  ) {
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
        bindings: { resolveCommandConversation },
        conversationBindings,
      },
    };
  }
  const runtimeChannelRegistry = {
    channels: [
      createRuntimeChannel(
        threadChannel,
        resolveThreadCommandConversation,
        setThreadBindingIdleTimeoutBySessionKeyMock,
        setThreadBindingMaxAgeBySessionKeyMock,
      ),
      createRuntimeChannel(
        roomChannel,
        resolveRoomCommandConversation,
        setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
        setMatrixThreadBindingMaxAgeBySessionKeyMock,
      ),
    ],
  };
  return {
    setThreadBindingIdleTimeoutBySessionKeyMock,
    setThreadBindingMaxAgeBySessionKeyMock,
    setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    setMatrixThreadBindingMaxAgeBySessionKeyMock,
    sessionBindingResolveByConversationMock,
    sessionBindingUnbindMock,
    runtimeChannelRegistry,
  };
});

vi.mock("../../plugins/runtime.js", () => {
  return {
    getActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    requireActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
    getActivePluginRegistryVersion: () => 1,
    getActivePluginChannelRegistryVersion: () => 1,
  };
});

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  getLoadedChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
  normalizeChannelId: (raw?: string | null) => {
    const normalized = raw?.trim().toLowerCase();
    return normalized || null;
  },
}));

vi.mock("../../channels/plugins/registry.js", () => ({
  getChannelPlugin: (channelId: string) =>
    hoisted.runtimeChannelRegistry.channels.find((entry) => entry.plugin.id === channelId)?.plugin,
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => {
  return {
    getSessionBindingService: () => ({
      bind: vi.fn(),
      getCapabilities: vi.fn(),
      listBySession: vi.fn(),
      resolveByConversationAsync: async (ref: unknown) =>
        hoisted.sessionBindingResolveByConversationMock(ref),
      touch: vi.fn(),
      unbind: hoisted.sessionBindingUnbindMock,
    }),
  };
});

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function buildSessionCommandParams(
  commandBody: string,
  ctxOverrides?: Record<string, unknown>,
): HandleCommandsParams {
  const ctx = {
    Body: commandBody,
    CommandBody: commandBody,
    CommandSource: "text",
    CommandAuthorized: true,
    Provider: "quietchat",
    Surface: "quietchat",
    From: "+1222",
    To: "+1222",
    SenderId: "user-1",
    ...ctxOverrides,
  } as HandleCommandsParams["ctx"];
  const channel = normalizeCommandContextText(ctx.Provider ?? ctx.Surface);
  const senderId = typeof ctx.SenderId === "string" ? ctx.SenderId : undefined;
  return {
    ctx,
    cfg: baseCfg,
    command: {
      surface: normalizeCommandContextText(ctx.Surface ?? ctx.Provider),
      channel,
      channelId: channel,
      ownerList: [],
      senderIsOwner: false,
      isAuthorizedSender: true,
      senderId,
      abortKey: senderId,
      rawBodyNormalized: commandBody.trim(),
      commandBodyNormalized: commandBody.trim().toLowerCase(),
      from: typeof ctx.From === "string" ? ctx.From : undefined,
      to: typeof ctx.To === "string" ? ctx.To : undefined,
    },
    directives: parseInlineSessionDirectives(commandBody),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:main",
    agentId: "main",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: channel,
    model: "test-model",
    contextTokens: 0,
    isGroup: false,
  };
}

function createThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: THREAD_CHANNEL,
    Surface: THREAD_CHANNEL,
    OriginatingChannel: THREAD_CHANNEL,
    OriginatingTo: "channel:thread-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
    ...overrides,
  });
}

function createRoomThreadCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$thread-1",
    ...overrides,
  });
}

function createRoomTriggerThreadCommandParams(
  commandBody: string,
  overrides?: Record<string, unknown>,
) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$root",
    ...overrides,
  });
}

function createRoomCommandParams(commandBody: string, overrides?: Record<string, unknown>) {
  return buildSessionCommandParams(commandBody, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    ...overrides,
  });
}

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

function createThreadBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createLifecycleBinding(
    {
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "thread-1",
    },
    overrides,
  );
}

function createRoomBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createLifecycleBinding(
    {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    },
    overrides,
  );
}

function createRoomTriggerBinding(overrides?: Partial<SessionBindingRecord>): SessionBindingRecord {
  return createRoomBinding({
    bindingId: "default:$root",
    conversation: {
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$root",
      parentConversationId: "!room:example.org",
    },
    ...overrides,
  });
}

describe("/session conversation bindings", () => {
  beforeEach(() => {
    hoisted.setThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock.mockReset();
    hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock.mockReset();
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    for (const { plugin } of hoisted.runtimeChannelRegistry.channels) {
      delete plugin.conversationBindings.setIdleTimeoutBySessionKeyAsync;
      delete plugin.conversationBindings.setMaxAgeBySessionKeyAsync;
    }
    vi.useRealTimers();
  });

  it.each([
    { name: "thread", createParams: createThreadCommandParams, createBinding: createThreadBinding },
    {
      name: "triggering thread",
      createParams: createRoomTriggerThreadCommandParams,
      createBinding: createRoomTriggerBinding,
    },
    {
      name: "generic conversation without lifecycle support",
      createParams: (body: string) =>
        buildSessionCommandParams(body, {
          Provider: "webchat",
          Surface: "webchat",
          OriginatingChannel: "webchat",
          OriginatingTo: "chat-1",
        }),
      createBinding: () =>
        createLifecycleBinding({
          channel: "webchat",
          accountId: "default",
          conversationId: "chat-1",
        }),
    },
  ])("unbinds only the current $name conversation", async ({ createParams, createBinding }) => {
    const binding = createBinding();
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
    const result = await handleSessionCommand(createParams("/session unbind"), true);
    expect(result?.reply?.text).toBe("✅ Conversation unbound.");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledExactlyOnceWith({
      bindingId: binding.bindingId,
      scope: binding.conversation,
      reason: "manual",
    });
  });

  it.each([
    { action: "unbind", boundBy: "user-1", message: "Only user-1 can unbind this conversation." },
    {
      action: "idle 2h",
      boundBy: "owner-1",
      message: "Only owner-1 can update session lifecycle settings",
    },
  ])("requires the binding owner for $action", async ({ action, boundBy, message }) => {
    const binding = createThreadBinding();
    binding.metadata = { ...binding.metadata, boundBy };
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
    const result = await handleSessionCommand(
      createThreadCommandParams(`/session ${action}`, { SenderId: "other-user" }),
      true,
    );
    expect(result?.reply?.text).toContain(message);
    expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
  });

  it.each(["unbind all", "idle 9999999999999"])("rejects invalid /session %s", async (action) => {
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
    const result = await handleSessionCommand(
      createThreadCommandParams(`/session ${action}`),
      true,
    );
    expect(result?.reply?.text).toBe(
      "Usage: /session idle <duration|off> | /session max-age <duration|off> | /session unbind (example: /session idle 24h)",
    );
    expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
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
      createParams: createRoomTriggerThreadCommandParams,
      createBinding: createRoomTriggerBinding,
      update: hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock,
    },
    {
      action: "max-age",
      value: "3h",
      durationMs: 3 * 60 * 60 * 1000,
      durationKey: "maxAgeMs",
      label: "Max age set to 3h",
      expiry: "2026-02-20T01:00:00.000Z",
      boundAgeMs: 2 * 60 * 60 * 1000,
      createParams: createRoomThreadCommandParams,
      createBinding: createRoomBinding,
      update: hoisted.setMatrixThreadBindingMaxAgeBySessionKeyMock,
    },
    {
      action: "max-age",
      value: "off",
      durationMs: 0,
      durationKey: "maxAgeMs",
      label: "Max age disabled",
      expiry: undefined,
      boundAgeMs: 0,
      createParams: createThreadCommandParams,
      createBinding: createThreadBinding,
      update: hoisted.setThreadBindingMaxAgeBySessionKeyMock,
    },
  ])("sets /session $action $value using the binding lifecycle", async (scenario) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
    const binding = scenario.createBinding({ boundAt: Date.now() - scenario.boundAgeMs });
    if (scenario.value === "off") {
      binding.metadata = { ...binding.metadata, maxAgeMs: 2 * 60 * 60 * 1000 };
    }
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(binding);
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
      expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
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
    {
      name: "active",
      lastActivityAt: Date.parse("2026-02-20T00:00:00.000Z"),
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    },
    {
      name: "out-of-range activity",
      lastActivityAt: 8_700_000_000_000_000,
      idleTimeoutMs: 2 * 60 * 60 * 1000,
    },
    {
      name: "overflowed timeout",
      lastActivityAt: Date.parse("2026-02-20T00:00:00.000Z"),
      idleTimeoutMs: Number.MAX_SAFE_INTEGER,
    },
  ])("reports $name idle timeout metadata", async ({ lastActivityAt, idleTimeoutMs }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-20T00:00:00.000Z"));
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createThreadBinding({
        metadata: { boundBy: "user-1", lastActivityAt, idleTimeoutMs, maxAgeMs: 0 },
      }),
    );
    const result = await handleSessionCommand(createThreadCommandParams("/session idle"), true);
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
    hoisted.sessionBindingResolveByConversationMock.mockImplementationOnce(() => {
      started.resolve();
      return lookup.promise;
    });
    const params = createThreadCommandParams("/session idle off");
    params.opts = { abortSignal: controller.signal };
    const result = handleSessionCommand(params, true);
    const failure = expect(result).rejects.toBe(reason);
    await started.promise;
    controller.abort(reason);
    lookup.resolve(createThreadBinding());
    await failure;
    expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
    expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).not.toHaveBeenCalled();
    expect(hoisted.sessionBindingUnbindMock).not.toHaveBeenCalled();
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
      hoisted.runtimeChannelRegistry.channels[0]!.plugin.conversationBindings[method] = () => {
        started.resolve();
        return mutation.promise;
      };
      hoisted.sessionBindingResolveByConversationMock.mockReturnValue(createThreadBinding());
      let settled = false;
      const result = handleSessionCommand(
        createThreadCommandParams(`/session ${action} off`),
        true,
      );
      void result.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
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
        expect(hoisted.setThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
        expect(hoisted.setThreadBindingMaxAgeBySessionKeyMock).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    {
      name: "channels without lifecycle support",
      createParams: buildSessionCommandParams,
      message:
        "currently available only on channels that support conversation binding lifecycle updates",
    },
    {
      name: "unbound room-chat threads",
      createParams: createRoomCommandParams,
      message: "This conversation is not currently bound.",
    },
  ])("rejects lifecycle updates for $name", async ({ createParams, message }) => {
    const result = await handleSessionCommand(createParams("/session idle 2h"), true);
    expect(result?.reply?.text).toContain(message);
    expect(hoisted.setMatrixThreadBindingIdleTimeoutBySessionKeyMock).not.toHaveBeenCalled();
  });
});
