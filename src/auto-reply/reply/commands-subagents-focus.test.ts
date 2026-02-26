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
  const getThreadBindingManagerMock = vi.fn();
  const resolveThreadBindingThreadNameMock = vi.fn(() => "🤖 codex");
  const readAcpSessionEntryMock = vi.fn();
  const sessionBindingCapabilitiesMock = vi.fn();
  const sessionBindingBindMock = vi.fn();
  const sessionBindingResolveByConversationMock = vi.fn();
  const sessionBindingListBySessionMock = vi.fn();
  const sessionBindingUnbindMock = vi.fn();
  return {
    callGatewayMock,
    getThreadBindingManagerMock,
    resolveThreadBindingThreadNameMock,
    readAcpSessionEntryMock,
    sessionBindingCapabilitiesMock,
    sessionBindingBindMock,
    sessionBindingResolveByConversationMock,
    sessionBindingListBySessionMock,
    sessionBindingUnbindMock,
  };
});

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

vi.mock("../../discord/monitor/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/monitor/thread-bindings.js")>();
  return {
    ...actual,
    getThreadBindingManager: hoisted.getThreadBindingManagerMock,
    resolveThreadBindingThreadName: hoisted.resolveThreadBindingThreadNameMock,
  };
});

vi.mock("../../infra/outbound/session-binding-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/session-binding-service.js")>();
  return {
    ...actual,
    getSessionBindingService: () => ({
      bind: (input: unknown) => hoisted.sessionBindingBindMock(input),
      getCapabilities: (params: unknown) => hoisted.sessionBindingCapabilitiesMock(params),
      listBySession: (targetSessionKey: string) =>
        hoisted.sessionBindingListBySessionMock(targetSessionKey),
      resolveByConversation: (ref: unknown) => hoisted.sessionBindingResolveByConversationMock(ref),
      touch: vi.fn(),
      unbind: (input: unknown) => hoisted.sessionBindingUnbindMock(input),
    }),
  };
});

installSubagentsCommandCoreMocks();

const { handleSubagentsCommand } = await import("./commands-subagents.js");
const { buildCommandTestParams } = await import("./commands-spawn.test-harness.js");

type FakeBinding = {
  accountId: string;
  channelId: string;
  threadId: string;
  targetKind: "subagent" | "acp";
  targetSessionKey: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
  boundBy: string;
  boundAt: number;
};

function createFakeBinding(
  overrides: Pick<FakeBinding, "threadId" | "targetKind" | "targetSessionKey" | "agentId"> &
    Partial<FakeBinding>,
): FakeBinding {
  return {
    accountId: "default",
    channelId: "parent-1",
    boundBy: "user-1",
    boundAt: Date.now(),
    ...overrides,
  };
}

function expectAgentListContainsThreadBinding(text: string, label: string, threadId: string): void {
  expect(text).toContain("agents:");
  expect(text).toContain(label);
  expect(text).toContain(`thread:${threadId}`);
}

function createFakeThreadBindingManager(initialBindings: FakeBinding[] = []) {
  const byThread = new Map<string, FakeBinding>(
    initialBindings.map((binding) => [binding.threadId, binding]),
  );

  const manager = {
    getSessionTtlMs: vi.fn(() => 24 * 60 * 60 * 1000),
    getByThreadId: vi.fn((threadId: string) => byThread.get(threadId)),
    listBySessionKey: vi.fn((targetSessionKey: string) =>
      [...byThread.values()].filter((binding) => binding.targetSessionKey === targetSessionKey),
    ),
    listBindings: vi.fn(() => [...byThread.values()]),
    bindTarget: vi.fn(async (params: Record<string, unknown>) => {
      const threadId =
        typeof params.threadId === "string" && params.threadId.trim()
          ? params.threadId.trim()
          : "thread-created";
      const targetSessionKey =
        typeof params.targetSessionKey === "string" ? params.targetSessionKey.trim() : "";
      const agentId =
        typeof params.agentId === "string" && params.agentId.trim()
          ? params.agentId.trim()
          : "main";
      const binding: FakeBinding = {
        accountId: "default",
        channelId:
          typeof params.channelId === "string" && params.channelId.trim()
            ? params.channelId.trim()
            : "parent-1",
        threadId,
        targetKind:
          params.targetKind === "subagent" || params.targetKind === "acp"
            ? params.targetKind
            : "acp",
        targetSessionKey,
        agentId,
        label: typeof params.label === "string" ? params.label : undefined,
        boundBy: typeof params.boundBy === "string" ? params.boundBy : "system",
        boundAt: Date.now(),
      };
      byThread.set(threadId, binding);
      return binding;
    }),
    unbindThread: vi.fn((params: { threadId: string }) => {
      const binding = byThread.get(params.threadId) ?? null;
      if (binding) {
        byThread.delete(params.threadId);
      }
      return binding;
    }),
  };

  return { manager, byThread };
}

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

function createStoredBinding(overrides?: Partial<FakeBinding>): FakeBinding {
  return {
    accountId: "default",
    channelId: "parent-1",
    threadId: "thread-1",
    targetKind: "subagent",
    targetSessionKey: "agent:main:subagent:child",
    agentId: "main",
    label: "child",
    boundBy: "user-1",
    boundAt: Date.now(),
    ...overrides,
  };
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

async function focusCodexAcpInThread(options?: { existingBinding?: SessionBindingRecord | null }) {
  hoisted.sessionBindingCapabilitiesMock.mockReturnValue({
    adapterAvailable: true,
    bindSupported: true,
    unbindSupported: true,
    placements: ["current", "child"],
  });
  hoisted.sessionBindingResolveByConversationMock.mockReturnValue(options?.existingBinding ?? null);
  hoisted.sessionBindingBindMock.mockImplementation(
    async (input: {
      targetSessionKey: string;
      conversation: { accountId: string; conversationId: string };
      metadata?: Record<string, unknown>;
    }) =>
      createSessionBindingRecord({
        targetSessionKey: input.targetSessionKey,
        conversation: {
          channel: "discord",
          accountId: input.conversation.accountId,
          conversationId: input.conversation.conversationId,
          parentConversationId: "parent-1",
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
  const params = createDiscordCommandParams("/focus codex-acp");
  const result = await handleSubagentsCommand(params, true);
  return { result };
}

describe("/focus, /unfocus, /agents", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockClear();
    hoisted.getThreadBindingManagerMock.mockClear().mockReturnValue(null);
    hoisted.resolveThreadBindingThreadNameMock.mockClear().mockReturnValue("🤖 codex");
    hoisted.readAcpSessionEntryMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingCapabilitiesMock.mockReset().mockReturnValue({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current", "child"],
    });
    hoisted.sessionBindingResolveByConversationMock.mockReset().mockReturnValue(null);
    hoisted.sessionBindingListBySessionMock.mockReset().mockReturnValue([]);
    hoisted.sessionBindingUnbindMock.mockReset().mockResolvedValue([]);
    hoisted.sessionBindingBindMock.mockReset();
  });

  it("/focus resolves ACP sessions and binds the current Discord thread", async () => {
    const { result } = await focusCodexAcpInThread();

    expect(result?.reply?.text).toContain("bound this thread");
    expect(result?.reply?.text).toContain("(acp)");
    expect(hoisted.sessionBindingBindMock).toHaveBeenCalledWith(
      expect.objectContaining({
        placement: "current",
        targetKind: "session",
        targetSessionKey: "agent:codex-acp:session-1",
        metadata: expect.objectContaining({
          introText:
            "⚙️ codex-acp session active (auto-unfocus in 24h). Messages here go directly to this session.",
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
    const { result } = await focusCodexAcpInThread();

    expect(result?.reply?.text).toContain("bound this thread");
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

  it("/unfocus removes an active thread binding for the binding owner", async () => {
    const fake = createFakeThreadBindingManager([createStoredBinding()]);
    hoisted.getThreadBindingManagerMock.mockReturnValue(fake.manager);

    const params = createDiscordCommandParams("/unfocus");
    const result = await handleSubagentsCommand(params, true);

    expect(result?.reply?.text).toContain("Thread unfocused");
    expect(fake.manager.unbindThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        reason: "manual",
      }),
    );
  });

  it("/unfocus also unbinds ACP-focused thread bindings", async () => {
    const fake = createFakeThreadBindingManager([
      createStoredBinding({
        targetKind: "acp",
        targetSessionKey: "agent:codex:acp:session-1",
        agentId: "codex",
        label: "codex-session",
      }),
    ]);
    hoisted.getThreadBindingManagerMock.mockReturnValue(fake.manager);

    const params = createDiscordCommandParams("/unfocus");
    const result = await handleSubagentsCommand(params, true);

    expect(result?.reply?.text).toContain("Thread unfocused");
    expect(fake.manager.unbindThread).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        reason: "manual",
      }),
    );
  });

  it("/focus rejects rebinding when the thread is focused by another user", async () => {
    const { result } = await focusCodexAcpInThread({
      existingBinding: createSessionBindingRecord({
        metadata: {
          boundBy: "user-2",
        },
      }),
    });

    expect(result?.reply?.text).toContain("Only user-2 can refocus this thread.");
    expect(hoisted.sessionBindingBindMock).not.toHaveBeenCalled();
  });

  it("/agents includes bound persistent sessions and requester-scoped ACP bindings", async () => {
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

    const fake = createFakeThreadBindingManager([
      createFakeBinding({
        threadId: "thread-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:child-1",
        agentId: "main",
        label: "child-1",
      }),
      createFakeBinding({
        threadId: "thread-2",
        targetKind: "acp",
        targetSessionKey: "agent:main:main",
        agentId: "codex-acp",
        label: "main-session",
      }),
      createFakeBinding({
        threadId: "thread-3",
        targetKind: "acp",
        targetSessionKey: "agent:codex-acp:session-2",
        agentId: "codex-acp",
        label: "codex-acp",
      }),
    ]);
    hoisted.getThreadBindingManagerMock.mockReturnValue(fake.manager);

    const params = createDiscordCommandParams("/agents");
    const result = await handleSubagentsCommand(params, true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("agents:");
    expect(text).toContain("thread:thread-1");
    expect(text).toContain("acp/session bindings:");
    expect(text).toContain("session:agent:main:main");
    expect(text).not.toContain("session:agent:codex-acp:session-2");
  });

  it("/agents keeps finished session-mode runs visible while their thread binding remains", async () => {
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

    const fake = createFakeThreadBindingManager([
      createFakeBinding({
        threadId: "thread-persistent-1",
        targetKind: "subagent",
        targetSessionKey: "agent:main:subagent:persistent-1",
        agentId: "main",
        label: "persistent-1",
      }),
    ]);
    hoisted.getThreadBindingManagerMock.mockReturnValue(fake.manager);

    const params = createDiscordCommandParams("/agents");
    const result = await handleSubagentsCommand(params, true);
    const text = result?.reply?.text ?? "";

    expectAgentListContainsThreadBinding(text, "persistent-1", "thread-persistent-1");
  });

  it("/focus is discord-only", async () => {
    const params = buildCommandTestParams("/focus codex-acp", baseCfg);
    const result = await handleSubagentsCommand(params, true);
    expect(result?.reply?.text).toContain("only available on Discord");
  });
});
