import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { installSubagentsCommandCoreMocks } from "./commands-subagents.test-mocks.js";

const hoisted = vi.hoisted(() => {
  const callGatewayMock = vi.fn();
  const getThreadBindingManagerMock = vi.fn();
  const resolveThreadBindingThreadNameMock = vi.fn(() => "🤖 codex");
  return {
    callGatewayMock,
    getThreadBindingManagerMock,
    resolveThreadBindingThreadNameMock,
  };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: hoisted.callGatewayMock,
}));

vi.mock("../../discord/monitor/thread-bindings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../discord/monitor/thread-bindings.js")>();
  return {
    ...actual,
    getThreadBindingManager: hoisted.getThreadBindingManagerMock,
    resolveThreadBindingThreadName: hoisted.resolveThreadBindingThreadNameMock,
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

async function focusCodexAcpInThread(fake = createFakeThreadBindingManager()) {
  hoisted.getThreadBindingManagerMock.mockReturnValue(fake.manager);
  hoisted.callGatewayMock.mockImplementation(async (request: unknown) => {
    const method = (request as { method?: string }).method;
    if (method === "sessions.resolve") {
      return { key: "agent:codex-acp:session-1" };
    }
    return {};
  });
  const params = createDiscordCommandParams("/focus codex-acp");
  const result = await handleSubagentsCommand(params, true);
  return { fake, result };
}

describe("/focus, /unfocus, /agents", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockClear();
    hoisted.getThreadBindingManagerMock.mockClear().mockReturnValue(null);
    hoisted.resolveThreadBindingThreadNameMock.mockClear().mockReturnValue("🤖 codex");
  });

  it("/focus resolves ACP sessions and binds the current Discord thread", async () => {
    const { fake, result } = await focusCodexAcpInThread();

    expect(result?.reply?.text).toContain("bound this thread");
    expect(result?.reply?.text).toContain("(acp)");
    expect(fake.manager.bindTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-1",
        createThread: false,
        targetKind: "acp",
        targetSessionKey: "agent:codex-acp:session-1",
        introText:
          "🤖 codex-acp session active (auto-unfocus in 24h). Messages here go directly to this session.",
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

  it("/focus rejects rebinding when the thread is focused by another user", async () => {
    const fake = createFakeThreadBindingManager([createStoredBinding({ boundBy: "user-2" })]);
    const { result } = await focusCodexAcpInThread(fake);

    expect(result?.reply?.text).toContain("Only user-2 can refocus this thread.");
    expect(fake.manager.bindTarget).not.toHaveBeenCalled();
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
