// Verifies unbound subagent lifecycle hooks, parent delivery, and failed-launch cleanup.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubagentSpawnTestConfig,
  expectRegisteredSubagentRun,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

type GatewayRequest = { method?: string; params?: Record<string, unknown> };
type TestBindingRequest = {
  targetSessionKey: string;
  targetKind?: string;
  conversation: {
    channel: string;
    accountId?: string;
    conversationId: string;
    parentConversationId?: string;
  };
  placement: "current" | "child";
  metadata?: Record<string, unknown>;
};

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
  configOverride: {} as Record<string, unknown>,
  updateSessionStoreMock: vi.fn(),
  registerSubagentRunMock: vi.fn(),
}));

const hookRunnerMocks = vi.hoisted(() => ({
  hasSubagentEndedHook: true,
  runSubagentSpawned: vi.fn(async () => {}),
  runSubagentProgress: vi.fn(async () => {}),
  runSubagentEnded: vi.fn(async () => {}),
}));

const bindingMocks = vi.hoisted(() => ({
  getCapabilities: vi.fn(() => ({
    adapterAvailable: true,
    bindSupported: true,
    placements: ["child"] as Array<"current" | "child">,
  })),
  bind: vi.fn(async (request: TestBindingRequest) => {
    const conversation = request.conversation;
    return {
      targetSessionKey: request.targetSessionKey,
      targetKind: request.targetKind,
      status: "active",
      conversation: {
        channel: conversation.channel,
        accountId: conversation.accountId ?? "default",
        conversationId: "456",
        parentConversationId: conversation.conversationId,
      },
    };
  }),
  listBySession: vi.fn(() => []),
}));

let resetSubagentRegistryForTests: typeof import("../registry/subagent-registry.test-helpers.js").resetSubagentRegistryForTests;
let spawnSubagentDirect: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let sessionStore: Record<string, Record<string, unknown>>;

// Stale callers may still supply these fields, but they cannot restore chat ownership.
const legacyThreadRequest = {
  childThread: { boundBy: "user-1" },
  thread: true,
  mode: "session",
};

function getGatewayRequests(): GatewayRequest[] {
  // Gateway call list is the observable side effect for spawn orchestration.
  return hoisted.callGatewayMock.mock.calls.map((call) => call[0] as GatewayRequest);
}

function getGatewayMethods() {
  return getGatewayRequests().map((request) => request.method);
}

function findGatewayRequest(method: string): GatewayRequest | undefined {
  return getGatewayRequests().find((request) => request.method === method);
}

const requireRecord = createRequireRecord("object", "expected-label");

function expectFields(value: unknown, expected: Record<string, unknown>, label = "object"): void {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${label}.${key}`).toEqual(expectedValue);
  }
}

function expectSubagentSessionKey(value: unknown, label: string): string {
  expect(value, label).toBeTypeOf("string");
  const sessionKey = value as string;
  expect(sessionKey.startsWith("agent:main:subagent:")).toBe(true);
  return sessionKey;
}

function setConfig(next: Record<string, unknown>) {
  hoisted.configOverride = createSubagentSpawnTestConfig(undefined, next);
}

async function spawn(params?: {
  task?: string;
  label?: string;
  model?: string;
  runTimeoutSeconds?: number;
  legacy?: typeof legacyThreadRequest;
  context?: "isolated" | "fork";
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
}) {
  return await spawnSubagentDirect(
    {
      task: params?.task ?? "do thing",
      ...(params?.label ? { label: params.label } : {}),
      ...(params?.model ? { model: params.model } : {}),
      ...(typeof params?.runTimeoutSeconds === "number"
        ? { runTimeoutSeconds: params.runTimeoutSeconds }
        : {}),
      ...params?.legacy,
      context: params?.context ?? "isolated",
    },
    {
      agentSessionKey: params?.agentSessionKey ?? "main",
      agentChannel: params?.agentChannel ?? "discord",
      agentAccountId: params?.agentAccountId,
      agentTo: params?.agentTo,
      agentThreadId: params?.agentThreadId,
      currentMessagingTarget: params?.currentMessagingTarget,
      currentChannelId: params?.currentChannelId,
      currentMessageId: params?.currentMessageId,
    },
  );
}

function mockAgentStartFailure() {
  hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
    const request = opts as { method?: string };
    if (request.method === "agent") {
      throw new Error("spawn failed");
    }
    return {};
  });
}

function requireSpawnedHookCall(): [Record<string, unknown>, Record<string, unknown>] {
  const call = hookRunnerMocks.runSubagentSpawned.mock.calls[0] as readonly unknown[] | undefined;
  if (!call) {
    throw new Error("expected spawned hook call");
  }
  return [requireRecord(call[0], "spawned event"), requireRecord(call[1], "spawned context")];
}

function getSpawnedEventCall(): Record<string, unknown> {
  const [event] = requireSpawnedHookCall();
  return event;
}

function expectParentOwnedSpawn(
  result: Awaited<ReturnType<typeof spawn>>,
  requesterOrigin: { channel: string; accountId?: string; to: string; threadId?: string | number },
): void {
  expectFields(
    result,
    {
      status: "accepted",
      runId: "run-1",
      mode: "run",
      context: "isolated",
      expectsCompletionMessage: true,
    },
    "spawn result",
  );
  expect(bindingMocks.getCapabilities).not.toHaveBeenCalled();
  expect(bindingMocks.bind).not.toHaveBeenCalled();
  expectFields(
    findGatewayRequest("agent")?.params,
    {
      ...requesterOrigin,
      threadId: requesterOrigin.threadId == null ? undefined : String(requesterOrigin.threadId),
      sessionKey: result.childSessionKey,
      deliver: false,
    },
    "agent params",
  );
  expect(getGatewayMethods()).not.toContain("sessions.delete");
  expect(hoisted.registerSubagentRunMock).toHaveBeenCalledTimes(1);
  expectRegisteredSubagentRun(
    hoisted.registerSubagentRunMock,
    {
      runId: "run-1",
      childSessionKey: result.childSessionKey,
      requesterSessionKey: "main",
      requesterOrigin,
      spawnMode: "run",
      expectsCompletionMessage: true,
    },
    { assertCurrent: undefined },
  );
  expect(hookRunnerMocks.runSubagentSpawned).toHaveBeenCalledTimes(1);
  expectFields(
    getSpawnedEventCall(),
    { childSessionKey: result.childSessionKey, mode: "run", threadRequested: false },
    "spawned event",
  );
}

beforeAll(async () => {
  ({ resetSubagentRegistryForTests, spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: hoisted.callGatewayMock,
    getRuntimeConfig: () => hoisted.configOverride,
    updateSessionStoreMock: hoisted.updateSessionStoreMock,
    registerSubagentRunMock: hoisted.registerSubagentRunMock,
    hookRunner: {
      hasHooks: (hookName: string) =>
        hookName === "subagent_spawned" ||
        hookName === "subagent_progress" ||
        (hookName === "subagent_ended" && hookRunnerMocks.hasSubagentEndedHook),
      runSubagentSpawned: hookRunnerMocks.runSubagentSpawned,
      runSubagentProgress: hookRunnerMocks.runSubagentProgress,
      runSubagentEnded: hookRunnerMocks.runSubagentEnded,
    },
    getSessionBindingService: () => bindingMocks,
    resetModules: false,
    sessionStorePath: "/tmp/subagent-spawn-hooks-session-store.json",
  }));
});

describe("sessions_spawn subagent lifecycle hooks", () => {
  beforeEach(() => {
    resetSubagentRegistryForTests();
    hoisted.callGatewayMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.registerSubagentRunMock.mockReset();
    hookRunnerMocks.hasSubagentEndedHook = true;
    hookRunnerMocks.runSubagentSpawned.mockClear();
    hookRunnerMocks.runSubagentProgress.mockClear();
    hookRunnerMocks.runSubagentEnded.mockClear();
    bindingMocks.getCapabilities.mockReset();
    bindingMocks.getCapabilities.mockReturnValue({
      adapterAvailable: true,
      bindSupported: true,
      placements: ["child"],
    });
    bindingMocks.bind.mockReset();
    bindingMocks.bind.mockImplementation(async (request: TestBindingRequest) => {
      const conversation = request.conversation;
      return {
        targetSessionKey: request.targetSessionKey,
        targetKind: request.targetKind,
        status: "active",
        conversation: {
          channel: conversation.channel,
          accountId: conversation.accountId ?? "default",
          conversationId: "456",
          parentConversationId: conversation.conversationId,
        },
      };
    });
    bindingMocks.listBySession.mockClear();
    setConfig({
      session: {
        mainKey: "main",
        scope: "per-sender",
        threadBindings: {
          defaultSpawnContext: "isolated",
        },
      },
    });
    sessionStore = {};
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_storePath: unknown, mutator: unknown) => {
        if (typeof mutator !== "function") {
          throw new Error("missing session store mutator");
        }
        await mutator(sessionStore);
        return sessionStore;
      },
    );
    hoisted.callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.patch") {
        return { ok: true };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      if (request.method === "agent") {
        return { runId: "run-1", status: "accepted", acceptedAt: 1_001 };
      }
      return {};
    });
  });

  afterEach(() => {
    resetSubagentRegistryForTests();
  });

  it("ignores legacy binding fields while preserving started/spawned metadata and order", async () => {
    const result = await spawn({
      label: "research",
      model: "openai/gpt-5.4",
      runTimeoutSeconds: 1,
      legacy: legacyThreadRequest,
      agentAccountId: "work",
      agentTo: "channel:123",
      agentThreadId: 456,
      currentMessagingTarget: "channel:source",
      currentChannelId: "source-native",
      currentMessageId: "message-789",
      context: "isolated",
    });

    expectFields(
      result,
      {
        status: "accepted",
        runId: "run-1",
        resolvedModel: "openai/gpt-5.4",
        resolvedProvider: "openai",
      },
      "spawn result",
    );
    expectParentOwnedSpawn(result, {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: 456,
    });

    const [event, ctx] = requireSpawnedHookCall();
    expectFields(
      event,
      {
        runId: "run-1",
        agentId: "main",
        label: "research",
        mode: "run",
        threadRequested: false,
        resolvedModel: "openai/gpt-5.4",
        resolvedProvider: "openai",
      },
      "spawned event",
    );
    expectFields(
      event.requester,
      {
        channel: "discord",
        accountId: "work",
        to: "channel:123",
        threadId: 456,
      },
      "spawned requester",
    );
    expectSubagentSessionKey(event.childSessionKey, "spawned event child session key");
    expectFields(
      ctx,
      {
        runId: "run-1",
        requesterSessionKey: "main",
        childSessionKey: event.childSessionKey,
      },
      "spawned context",
    );
    expect(hookRunnerMocks.runSubagentProgress).toHaveBeenCalledTimes(1);
    expect(hookRunnerMocks.runSubagentProgress).toHaveBeenCalledWith(
      {
        phase: "started",
        runId: "run-1",
        childSessionKey: event.childSessionKey,
        requester: {
          channel: "discord",
          accountId: "work",
          to: "channel:source",
          threadId: 456,
          channelId: "source-native",
          messageId: "message-789",
        },
      },
      ctx,
    );
    expect(
      hoisted.registerSubagentRunMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      hookRunnerMocks.runSubagentProgress.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(
      hookRunnerMocks.runSubagentProgress.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    ).toBeLessThan(
      hookRunnerMocks.runSubagentSpawned.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("keeps ordinary spawns on the parent completion path", async () => {
    const result = await spawn({
      runTimeoutSeconds: 1,
      agentTo: "channel:123",
    });

    expectParentOwnedSpawn(result, { channel: "discord", to: "channel:123" });
    const event = getSpawnedEventCall();
    expectFields(
      event.requester,
      {
        channel: "discord",
        to: "channel:123",
      },
      "spawned requester",
    );
  });

  it("accepts legacy binding fields even when the adapter would reject binding", async () => {
    bindingMocks.bind.mockRejectedValueOnce(
      new Error("Unable to create or bind a Discord thread for this subagent session."),
    );
    const result = await spawn({
      runTimeoutSeconds: 1,
      legacy: legacyThreadRequest,
      agentAccountId: "work",
      agentTo: "channel:123",
      context: "isolated",
    });

    expectParentOwnedSpawn(result, { channel: "discord", accountId: "work", to: "channel:123" });
  });

  it("does not depend on an adapter producing a bound conversation", async () => {
    bindingMocks.bind.mockResolvedValueOnce({
      targetSessionKey: "agent:main:subagent:test",
      targetKind: "subagent",
      status: "active",
      conversation: {
        channel: "discord",
        accountId: "work",
        conversationId: "",
        parentConversationId: "123",
      },
    });
    const result = await spawn({
      runTimeoutSeconds: 1,
      legacy: legacyThreadRequest,
      agentAccountId: "work",
      agentTo: "channel:123",
      context: "isolated",
    });

    expectParentOwnedSpawn(result, { channel: "discord", accountId: "work", to: "channel:123" });
  });

  it("accepts legacy binding fields on channels without a binding adapter", async () => {
    bindingMocks.getCapabilities.mockReturnValueOnce({
      adapterAvailable: false,
      bindSupported: false,
      placements: [],
    });
    const result = await spawn({
      legacy: legacyThreadRequest,
      agentChannel: "signal",
      agentTo: "+123",
      context: "isolated",
    });

    expectParentOwnedSpawn(result, { channel: "signal", to: "+123" });
  });

  it.each([true, false])(
    "deletes the created session on launch failure with ended hook available=%s",
    async (hasSubagentEndedHook) => {
      hookRunnerMocks.hasSubagentEndedHook = hasSubagentEndedHook;
      mockAgentStartFailure();
      const result = await spawn({
        legacy: legacyThreadRequest,
        agentAccountId: "work",
        agentTo: "channel:123",
        agentThreadId: "456",
        context: "isolated",
      });

      expectFields(result, { status: "error", error: "spawn failed" }, "spawn result");
      const childSessionKey = expectSubagentSessionKey(
        result.childSessionKey,
        "failed child session key",
      );
      const entry = requireRecord(sessionStore[childSessionKey], "created child session");
      expect(entry.sessionId).toEqual(expect.any(String));
      expect(entry.lifecycleRevision).toEqual(expect.any(String));
      expect(bindingMocks.bind).not.toHaveBeenCalled();
      expect(hookRunnerMocks.runSubagentProgress).not.toHaveBeenCalled();
      expect(hookRunnerMocks.runSubagentSpawned).not.toHaveBeenCalled();
      expect(hookRunnerMocks.runSubagentEnded).not.toHaveBeenCalled();
      expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
      const methods = getGatewayMethods();
      expect(methods.filter((method) => method === "agent")).toHaveLength(1);
      expect(methods.filter((method) => method === "sessions.delete")).toHaveLength(1);
      expect(methods.indexOf("agent")).toBeLessThan(methods.indexOf("sessions.delete"));
      const deleteCall = findGatewayRequest("sessions.delete");
      expectFields(
        deleteCall?.params,
        {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: false,
          expectedSessionId: entry.sessionId,
          expectedLifecycleRevision: entry.lifecycleRevision,
        },
        "delete params",
      );
    },
  );
});
