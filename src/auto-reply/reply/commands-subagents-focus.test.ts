import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { installSubagentsCommandCoreMocks } from "./commands-subagents.test-mocks.js";

const THREAD_CHANNEL = "thread-chat";
const ROOM_CHANNEL = "room-chat";
const TOPIC_CHANNEL = "topic-chat";

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

function resolveThreadCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    params.threadParentId,
    params.originatingTo
      ?.replace(/^thread-chat:/i, "")
      .replace(/^channel:/i, "")
      .trim(),
    params.commandTo
      ?.replace(/^thread-chat:/i, "")
      .replace(/^channel:/i, "")
      .trim(),
    params.fallbackTo
      ?.replace(/^thread-chat:/i, "")
      .replace(/^channel:/i, "")
      .trim(),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function normalizeRoomTarget(raw?: string): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(/^room-chat:/i, "")
    .replace(/^room:/i, "")
    .trim();
}

function resolveRoomCommandConversation(params: ResolveCommandConversationParams) {
  const parentConversationId = firstText([
    normalizeRoomTarget(params.originatingTo),
    normalizeRoomTarget(params.commandTo),
    normalizeRoomTarget(params.fallbackTo),
  ]);
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveTopicCommandConversation(params: ResolveCommandConversationParams) {
  const chatId = firstText([params.originatingTo, params.commandTo, params.fallbackTo])
    ?.replace(/^topic-chat:/i, "")
    .replace(/:topic:\d+$/i, "")
    .trim();
  if (!chatId) {
    return null;
  }
  if (params.threadId) {
    return {
      conversationId: `${chatId}:topic:${params.threadId}`,
      parentConversationId: chatId,
    };
  }
  if (chatId.startsWith("-")) {
    return null;
  }
  return {
    conversationId: chatId,
    parentConversationId: chatId,
  };
}

const hoisted = vi.hoisted(() => {
  const threadChannel = "thread-chat";
  const roomChannel = "room-chat";
  const topicChannel = "topic-chat";
  const callGatewayMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  const runtimeChannelRegistry = {
    channels: [
      {
        plugin: {
          id: threadChannel,
          meta: {},
          config: { hasPersistedAuthState: () => false },
          bindings: { resolveCommandConversation: resolveThreadCommandConversation },
        },
      },
      {
        plugin: {
          id: roomChannel,
          meta: {},
          config: { hasPersistedAuthState: () => false },
          conversationBindings: { defaultTopLevelPlacement: "child" },
          bindings: { resolveCommandConversation: resolveRoomCommandConversation },
        },
      },
      {
        plugin: {
          id: topicChannel,
          meta: {},
          config: { hasPersistedAuthState: () => false },
          conversationBindings: { defaultTopLevelPlacement: "current" },
          bindings: { resolveCommandConversation: resolveTopicCommandConversation },
        },
      },
    ],
  };
  return {
    callGatewayMock,
    readAcpSessionEntryMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingResolveByConversationMock,
    sessionBindingListBySessionMock,
    sessionBindingUnbindMock,
    runtimeChannelRegistry,
  };
});

function buildFocusSessionBindingService() {
  return {
    touch: vi.fn(),
    listBySession(targetSessionKey: string) {
      return hoisted.sessionBindingListBySessionMock(targetSessionKey);
    },
    resolveByConversation(ref: unknown) {
      return hoisted.sessionBindingResolveByConversationMock(ref);
    },
    getCapabilities(params: unknown) {
      return hoisted.sessionBindingCapabilitiesMock(params);
    },
    bind(input: unknown) {
      return hoisted.sessionBindingBindMock(input);
    },
    unbind(input: unknown) {
      return hoisted.sessionBindingUnbindMock(input);
    },
  };
}

vi.mock("../../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));

vi.mock("../../acp/runtime/session-meta.js", async () => {
  const actual = await vi.importActual<typeof import("../../acp/runtime/session-meta.js")>(
    "../../acp/runtime/session-meta.js",
  );
  return {
    ...actual,
    readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../infra/outbound/session-binding-service.js")
  >("../../infra/outbound/session-binding-service.js");
  return {
    ...actual,
    getSessionBindingService: () => buildFocusSessionBindingService(),
  };
});

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
  requireActivePluginRegistry: () => hoisted.runtimeChannelRegistry,
  getActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
  requireActivePluginChannelRegistry: () => hoisted.runtimeChannelRegistry,
  getActivePluginRegistryVersion: () => 1,
  getActivePluginChannelRegistryVersion: () => 1,
}));

installSubagentsCommandCoreMocks();

const { handleSubagentsCommand } = await import("./commands-subagents.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createThreadCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCfg, {
    Provider: THREAD_CHANNEL,
    Surface: THREAD_CHANNEL,
    OriginatingChannel: THREAD_CHANNEL,
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
  });
  params.command.senderId = "user-1";
  return params;
}

function createThreadCommandParamsWithoutAccountId(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: THREAD_CHANNEL,
    Surface: THREAD_CHANNEL,
    OriginatingChannel: THREAD_CHANNEL,
    OriginatingTo: "channel:parent-1",
    MessageThreadId: "thread-1",
  });
  params.command.senderId = "user-1";
  return params;
}

function createTopicCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCfg, {
    Provider: TOPIC_CHANNEL,
    Surface: TOPIC_CHANNEL,
    OriginatingChannel: TOPIC_CHANNEL,
    OriginatingTo: "-100200300:topic:77",
    AccountId: "default",
    MessageThreadId: "77",
  });
  params.command.senderId = "user-1";
  return params;
}

function createRoomThreadCommandParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$thread-1",
  });
  params.command.senderId = "user-1";
  return params;
}

function createRoomTriggerThreadCommandParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
    MessageThreadId: "$root",
  });
  params.command.senderId = "user-1";
  return params;
}

function createRoomCommandParams(commandBody: string, cfg: OpenClawConfig = baseCfg) {
  const params = buildCommandTestParams(commandBody, cfg, {
    Provider: ROOM_CHANNEL,
    Surface: ROOM_CHANNEL,
    OriginatingChannel: ROOM_CHANNEL,
    OriginatingTo: "room:!room:example.org",
    AccountId: "default",
  });
  params.command.senderId = "user-1";
  return params;
}

function createSessionBindingRecord(
  overrides?: Partial<SessionBindingRecord>,
): SessionBindingRecord {
  return {
    bindingId: "default:thread-1",
    targetSessionKey: "agent:codex-acp:session-1",
    targetKind: "session",
    conversation: {
      channel: THREAD_CHANNEL,
      accountId: "default",
      conversationId: "thread-1",
      parentConversationId: "parent-1",
    },
    status: "active",
    boundAt: Date.now(),
    metadata: {
      boundBy: "user-1",
      agentId: "codex-acp",
    },
    ...overrides,
  };
}

function createSessionBindingCapabilities() {
  return {
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"] as const,
  };
}

async function focusCodexAcp(
  params = createThreadCommandParams("/focus codex-acp"),
  options?: { existingBinding?: SessionBindingRecord | null },
) {
  hoisted.sessionBindingCapabilitiesMock.mockReturnValue(createSessionBindingCapabilities());
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(options?.existingBinding ?? null);
  hoisted.sessionBindingBindMock.mockImplementation(
    async (input: {
      targetSessionKey: string;
      placement: "current" | "child";
      conversation: {
        channel: string;
        accountId: string;
        conversationId: string;
        parentConversationId?: string;
      };
      metadata?: Record<string, unknown>;
    }) =>
      createSessionBindingRecord({
        targetSessionKey: input.targetSessionKey,
        conversation: {
          channel: input.conversation.channel,
          accountId: input.conversation.accountId,
          conversationId:
            input.placement === "child" ? "thread-created" : input.conversation.conversationId,
          ...(input.conversation.parentConversationId
            ? { parentConversationId: input.conversation.parentConversationId }
            : {}),
        },
        metadata: {
          boundBy: typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy : "user-1",
        },
      }),
  );
  hoisted.callGatewayMock.mockImplementation(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "sessions.resolve") {
      return { key: "agent:codex-acp:session-1" };
    }
    return {};
  });
  return await handleSubagentsCommand(params, true);
}

describe("/focus, /unfocus, /agents", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.readAcpSessionEntryMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingCapabilitiesMock
      .mockReset()
      .mockReturnValue(createSessionBindingCapabilities());
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    hoisted.sessionBindingBindMock.mockReset();
  });

  it("/focus resolves ACP sessions and binds the current thread-chat thread", async () => {
    const result = await focusCodexAcp();

    expect(result?.reply?.text).toContain("bound this conversation");
    expect(result?.reply?.text).toContain("(acp)");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        targetKind: "session",
        targetSessionKey: "agent:codex-acp:session-1",
        conversation: expect.objectContaining({
          channel: THREAD_CHANNEL,
          conversationId: "thread-1",
        }),
        metadata: expect.objectContaining({
          introText:
            "⚙️ codex-acp session active (idle auto-unfocus after 24h inactivity). Messages here go directly to this session.",
        }),
      }),
    );
  });

  it("/focus binds topic-chat topics as current conversations", async () => {
    const result = await focusCodexAcp(createTopicCommandParams("/focus codex-acp"));

    expect(result?.reply?.text).toContain("bound this conversation");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: TOPIC_CHANNEL,
          conversationId: "-100200300:topic:77",
        }),
      }),
    );
  });

  it("/focus creates a room-chat thread from a top-level room when spawnSubagentSessions is enabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        [ROOM_CHANNEL]: {
          threadBindings: {
            enabled: true,
            spawnSubagentSessions: true,
          },
        },
      } as OpenClawConfig["channels"],
    } as OpenClawConfig;

    const result = await focusCodexAcp(createRoomCommandParams("/focus codex-acp", cfg));

    expect(result?.reply?.text).toContain("created child conversation thread-created and bound it");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "child",
        conversation: expect.objectContaining({
          channel: ROOM_CHANNEL,
          conversationId: "!room:example.org",
        }),
      }),
    );
  });

  it("/focus treats the triggering room-chat always-thread turn as the current thread", async () => {
    const result = await focusCodexAcp(createRoomTriggerThreadCommandParams("/focus codex-acp"));

    expect(result?.reply?.text).toContain("bound this conversation");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: ROOM_CHANNEL,
          conversationId: "$root",
          parentConversationId: "!room:example.org",
        }),
      }),
    );
  });

  it("/focus rejects room-chat top-level thread creation when spawnSubagentSessions is disabled", async () => {
    const cfg = {
      ...baseCfg,
      channels: {
        [ROOM_CHANNEL]: {
          threadBindings: {
            enabled: true,
          },
        },
      } as OpenClawConfig["channels"],
    } as OpenClawConfig;

    const result = await focusCodexAcp(createRoomCommandParams("/focus codex-acp", cfg));

    expect(result?.reply?.text).toContain(
      `channels.${ROOM_CHANNEL}.threadBindings.spawnSubagentSessions=true`,
    );
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("/focus includes ACP session identifiers in intro text when available", async () => {
    hoisted.readAcpSessionEntryMock.mockReturnValue({
      sessionKey: "agent:codex-acp:session-1",
      storeSessionKey: "agent:codex-acp:session-1",
      acp: {
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: "runtime-1",
        identity: {
          state: "resolved",
          source: "status",
          acpxSessionId: "acpx-456",
          agentSessionId: "codex-123",
          lastUpdatedAt: Date.now(),
        },
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      },
    });
    await focusCodexAcp();

    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("agent session id: codex-123"),
        }),
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("acpx session id: acpx-456"),
        }),
      }),
    );
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          introText: expect.stringContaining("codex resume codex-123"),
        }),
      }),
    );
  });

  it("/unfocus removes an active binding for the binding owner", async () => {
    const params = createThreadCommandParams("/unfocus");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:thread-1",
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsCommand(params, true);

    expect(result?.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:thread-1",
      reason: "manual",
    });
  });

  it("/unfocus removes an active room-chat thread binding for the binding owner", async () => {
    const params = createRoomThreadCommandParams("/unfocus");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:room-thread-1",
        conversation: {
          channel: ROOM_CHANNEL,
          accountId: "default",
          conversationId: "$thread-1",
          parentConversationId: "!room:example.org",
        },
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsCommand(params, true);

    expect(result?.reply?.text).toContain("Conversation unfocused");
    expect(hoisted.sessionBindingResolveByConversationMock).toHaveBeenCalledWith({
      channel: ROOM_CHANNEL,
      accountId: "default",
      conversationId: "$thread-1",
      parentConversationId: "!room:example.org",
    });
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:room-thread-1",
      reason: "manual",
    });
  });

  it("/focus rejects rebinding when the thread is focused by another user", async () => {
    const result = await focusCodexAcp(undefined, {
      existingBinding: createSessionBindingRecord({
        metadata: { boundBy: "user-2" },
      }),
    });

    expect(result?.reply?.text).toContain("Only user-2 can refocus this conversation.");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("/agents includes active conversation bindings on the current channel/account", async () => {
    addSubagentRunForTests({
      runId: "run-1",
      childSessionKey: "agent:main:subagent:child-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "test task",
      cleanup: "keep",
      label: "child-1",
      createdAt: Date.now(),
    });

    hoisted.sessionBindingListBySessionMock.mockImplementation((sessionKey: string) => {
      if (sessionKey === "agent:main:subagent:child-1") {
        return [
          createSessionBindingRecord({
            bindingId: "default:thread-1",
            targetSessionKey: sessionKey,
            targetKind: "subagent",
            conversation: {
              channel: THREAD_CHANNEL,
              accountId: "default",
              conversationId: "thread-1",
            },
          }),
        ];
      }
      if (sessionKey === "agent:main:main") {
        return [
          createSessionBindingRecord({
            bindingId: "default:thread-2",
            targetSessionKey: sessionKey,
            targetKind: "session",
            conversation: {
              channel: THREAD_CHANNEL,
              accountId: "default",
              conversationId: "thread-2",
            },
            metadata: { label: "main-session" },
          }),
          // Mismatched channel should be filtered.
          createSessionBindingRecord({
            bindingId: "default:tg-1",
            targetSessionKey: sessionKey,
            targetKind: "session",
            conversation: {
              channel: TOPIC_CHANNEL,
              accountId: "default",
              conversationId: "12345",
            },
          }),
        ];
      }
      return [];
    });

    const result = await handleSubagentsCommand(createThreadCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("agents:");
    expect(text).toContain("binding:thread-1");
    expect(text).toContain("acp/session bindings:");
    expect(text).toContain("session:agent:main:main");
    expect(text).not.toContain("default:tg-1");
  });

  it("/agents keeps finished session-mode runs visible while binding remains", async () => {
    addSubagentRunForTests({
      runId: "run-session-1",
      childSessionKey: "agent:main:subagent:persistent-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "persistent task",
      cleanup: "keep",
      label: "persistent-1",
      spawnMode: "session",
      createdAt: Date.now(),
      endedAt: Date.now(),
    });
    hoisted.sessionBindingListBySessionMock.mockImplementation((sessionKey: string) => {
      if (sessionKey !== "agent:main:subagent:persistent-1") {
        return [];
      }
      return [
        createSessionBindingRecord({
          bindingId: "default:thread-persistent-1",
          targetSessionKey: sessionKey,
          targetKind: "subagent",
          conversation: {
            channel: THREAD_CHANNEL,
            accountId: "default",
            conversationId: "thread-persistent-1",
          },
        }),
      ];
    });

    const result = await handleSubagentsCommand(createThreadCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("persistent-1");
    expect(text).toContain("binding:thread-persistent-1");
  });

  it("/agents honors the plugin default account when AccountId is omitted", async () => {
    hoisted.runtimeChannelRegistry.channels[0]!.plugin.config.defaultAccountId = () => "work";
    addSubagentRunForTests({
      runId: "run-work-1",
      childSessionKey: "agent:main:subagent:work-1",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "work task",
      cleanup: "keep",
      label: "work-1",
      createdAt: Date.now(),
    });

    hoisted.sessionBindingListBySessionMock.mockImplementation((sessionKey: string) => {
      if (sessionKey !== "agent:main:subagent:work-1") {
        return [];
      }
      return [
        createSessionBindingRecord({
          bindingId: "work:thread-work-1",
          targetSessionKey: sessionKey,
          targetKind: "subagent",
          conversation: {
            channel: THREAD_CHANNEL,
            accountId: "work",
            conversationId: "thread-work-1",
          },
        }),
      ];
    });

    const result = await handleSubagentsCommand(
      createThreadCommandParamsWithoutAccountId("/agents"),
      true,
    );
    const text = result?.reply?.text ?? "";

    expect(text).toContain("work-1");
    expect(text).toContain("binding:thread-work-1");
  });

  it("/focus rejects unsupported channels", async () => {
    const params = buildCommandTestParams("/focus codex-acp", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result?.reply?.text).toContain("must be run inside a bindable conversation");
  });
});
