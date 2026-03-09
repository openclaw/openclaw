import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { installSubagentsCommandCoreMocks } from "./commands-subagents.test-mocks.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const readAcpSessionEntryMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  return {
    callGatewayMock,
    readAcpSessionEntryMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingResolveByConversationMock,
    sessionBindingListBySessionMock,
    sessionBindingUnbindMock,
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

vi.mock("../../acp/runtime/session-meta.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../acp/runtime/session-meta.js")>();
  return {
    ...actual,
    readAcpSessionEntry: (params: unknown) => hoisted.readAcpSessionEntryMock(params),
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
    getSessionBindingService: () => buildFocusSessionBindingService(),
  };
});

installSubagentsCommandCoreMocks();

const { handleSubagentsCommand } = await import("./commands-subagents.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

const baseCfg = {
  session: { mainKey: "main", scope: "per-sender" },
} satisfies OpenClawConfig;

function createDiscordCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCfg, {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:parent-1",
    AccountId: "default",
    MessageThreadId: "thread-1",
  });
  params.command.senderId = "user-1";
  return params;
}

function createTelegramTopicCommandParams(commandBody: string) {
  const params = buildCommandTestParams(commandBody, baseCfg, {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "-100200300:topic:77",
    AccountId: "default",
    MessageThreadId: "77",
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
      channel: "discord",
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
  params = createDiscordCommandParams("/focus codex-acp"),
  options?: { existingBinding?: SessionBindingRecord | null },
) {
  hoisted.sessionBindingCapabilitiesMock.mockReturnValue(createSessionBindingCapabilities());
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(options?.existingBinding ?? null);
  hoisted.sessionBindingBindMock.mockImplementation(
    async (input: {
      targetSessionKey: string;
      conversation: { channel: string; accountId: string; conversationId: string };
      metadata?: Record<string, unknown>;
    }) =>
      createSessionBindingRecord({
        targetSessionKey: input.targetSessionKey,
        conversation: {
          channel: input.conversation.channel,
          accountId: input.conversation.accountId,
          conversationId: input.conversation.conversationId,
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

  it("/focus resolves ACP sessions and binds the current Discord thread", async () => {
    const result = await focusCodexAcp();

    expect(result?.reply?.text).toContain("bound this thread");
    expect(result?.reply?.text).toContain("(acp)");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        targetKind: "session",
        targetSessionKey: "agent:codex-acp:session-1",
        conversation: expect.objectContaining({
          channel: "discord",
          conversationId: "thread-1",
        }),
        metadata: expect.objectContaining({
          introText:
            "⚙️ codex-acp session active (idle auto-unfocus after 24h inactivity). Messages here go directly to this session.",
        }),
      }),
    );
  });

  it("/focus binds Telegram topics as current conversations", async () => {
    const result = await focusCodexAcp(createTelegramTopicCommandParams("/focus codex-acp"));

    expect(result?.reply?.text).toContain("bound this conversation");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        conversation: expect.objectContaining({
          channel: "telegram",
          conversationId: "-100200300:topic:77",
        }),
      }),
    );
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
    const params = createDiscordCommandParams("/unfocus");
    hoisted.sessionBindingResolveByConversationMock.mockReturnValue(
      createSessionBindingRecord({
        bindingId: "default:thread-1",
        metadata: { boundBy: "user-1" },
      }),
    );

    const result = await handleSubagentsCommand(params, true);

    expect(result?.reply?.text).toContain("Thread unfocused");
    expect(hoisted.sessionBindingUnbindMock).toHaveBeenCalledWith({
      bindingId: "default:thread-1",
      reason: "manual",
    });
  });

  it("/focus rejects rebinding when the thread is focused by another user", async () => {
    const result = await focusCodexAcp(undefined, {
      existingBinding: createSessionBindingRecord({
        metadata: { boundBy: "user-2" },
      }),
    });

    expect(result?.reply?.text).toContain("Only user-2 can refocus this thread.");
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
              channel: "discord",
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
              channel: "discord",
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
              channel: "telegram",
              accountId: "default",
              conversationId: "12345",
            },
          }),
        ];
      }
      return [];
    });

    const result = await handleSubagentsCommand(createDiscordCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("agents:");
    expect(text).toContain("thread:thread-1");
    expect(text).toContain("acp/session bindings:");
    expect(text).toContain("session:agent:main:main");
    expect(text).not.toContain("default:tg-1");
  });

  it("/agents lists the requester agent when no bindings exist", async () => {
    const result = await handleSubagentsCommand(createDiscordCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("agents:");
    expect(text).toContain("- main");
    expect(text).not.toContain("(none)");
    expect(text).not.toContain("active conversation bindings:");
  });

  it("/agents includes allowlisted custom subagents even when tools.agentToAgent is disabled", async () => {
    const cfg = {
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        list: [
          {
            id: "main",
            subagents: {
              allowAgents: ["*"],
            },
          },
          {
            id: "ssh-agent",
            name: "SSH Agent",
          },
        ],
      },
      tools: {
        agentToAgent: {
          enabled: false,
        },
      },
    } satisfies OpenClawConfig;
    const params = buildCommandTestParams("/agents", cfg, {
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      OriginatingTo: "channel:parent-1",
      AccountId: "default",
      MessageThreadId: "thread-1",
    });
    params.command.senderId = "user-1";

    const result = await handleSubagentsCommand(params, true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("agents:");
    expect(text).toContain("- main");
    expect(text).toContain("- ssh-agent (SSH Agent)");
    expect(text).not.toContain("(none)");
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
            channel: "discord",
            accountId: "default",
            conversationId: "thread-persistent-1",
          },
        }),
      ];
    });

    const result = await handleSubagentsCommand(createDiscordCommandParams("/agents"), true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("persistent-1");
    expect(text).toContain("thread:thread-persistent-1");
  });

  it("/focus rejects unsupported channels", async () => {
    const params = buildCommandTestParams("/focus codex-acp", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result?.reply?.text).toContain("only available on Discord and Telegram");
  });
});
