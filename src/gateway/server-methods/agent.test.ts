import { afterEach, describe, expect, it, vi } from "vitest";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  performGatewaySessionReset: vi.fn(),
  loadConfigReturn: {} as Record<string, unknown>,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
    resolveAgentMainSessionKey: ({
      cfg,
      agentId,
    }: {
      cfg?: { session?: { mainKey?: string } };
      agentId: string;
    }) => `agent:${agentId}:${cfg?.session?.mainKey ?? "main"}`,
  };
});

vi.mock("../../commands/agent.js", () => ({
  agentCommand: mocks.agentCommand,
  agentCommandFromIngress: mocks.agentCommand,
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    loadConfig: () => mocks.loadConfigReturn,
  };
});

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("../session-reset-service.js", () => ({
  performGatewaySessionReset: (...args: unknown[]) =>
    (mocks.performGatewaySessionReset as (...args: unknown[]) => unknown)(...args),
}));

vi.mock("../../sessions/send-policy.js", () => ({
  resolveSendPolicy: () => "allow",
}));

vi.mock("../../utils/delivery-context.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils/delivery-context.js")>(
    "../../utils/delivery-context.js",
  );
  return {
    ...actual,
    normalizeSessionDeliveryFields: () => ({}),
  };
});

const makeContext = (): GatewayRequestContext =>
  ({
    dedupe: new Map(),
    addChatRun: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  }) as unknown as GatewayRequestContext;

type AgentHandlerArgs = Parameters<typeof agentHandlers.agent>[0];
type AgentParams = AgentHandlerArgs["params"];

type AgentIdentityGetHandlerArgs = Parameters<(typeof agentHandlers)["agent.identity.get"]>[0];
type AgentIdentityGetParams = AgentIdentityGetHandlerArgs["params"];

function mockMainSessionEntry(entry: Record<string, unknown>, cfg: Record<string, unknown> = {}) {
  mocks.loadSessionEntry.mockReturnValue({
    cfg,
    storePath: "/tmp/sessions.json",
    entry: {
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      ...entry,
    },
    canonicalKey: "agent:main:main",
  });
}

function captureUpdatedMainEntry(freshEntry?: Record<string, unknown>) {
  let capturedEntry: Record<string, unknown> | undefined;
  mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
    const store: Record<string, unknown> = freshEntry ? { "agent:main:main": freshEntry } : {};
    const result = await updater(store);
    capturedEntry = store["agent:main:main"] as Record<string, unknown>;
    return result;
  });
  return () => capturedEntry;
}

function buildExistingMainStoreEntry(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: "existing-session-id",
    updatedAt: Date.now(),
    ...overrides,
  };
}

async function runMainAgentAndCaptureEntry(idempotencyKey: string) {
  const getCapturedEntry = captureUpdatedMainEntry();
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
  await runMainAgent("test", idempotencyKey);
  expect(mocks.updateSessionStore).toHaveBeenCalled();
  return getCapturedEntry();
}

function setupNewYorkTimeConfig(isoDate: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoDate)); // Wed Jan 28, 8:30 PM EST
  mocks.agentCommand.mockClear();
  mocks.loadConfigReturn = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
      },
    },
  };
}

function resetTimeConfig() {
  mocks.loadConfigReturn = {};
  vi.useRealTimers();
}

async function expectResetCall(expectedMessage: string) {
  await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
  expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
  const call = readLastAgentCommandCall();
  expect(call?.message).toBe(expectedMessage);
  return call;
}

function primeMainAgentRun(params?: { sessionId?: string; cfg?: Record<string, unknown> }) {
  const sessionId = params?.sessionId ?? "existing-session-id";
  mockMainSessionEntry({ sessionId }, params?.cfg ?? {});
  captureUpdatedMainEntry(buildExistingMainStoreEntry({ sessionId }));
  mocks.agentCommand.mockResolvedValue({
    payloads: [{ text: "ok" }],
    meta: { durationMs: 100 },
  });
}

async function runMainAgent(message: string, idempotencyKey: string) {
  const respond = vi.fn();
  await invokeAgent(
    {
      message,
      agentId: "main",
      sessionKey: "agent:main:main",
      idempotencyKey,
    },
    { respond, reqId: idempotencyKey },
  );
  return respond;
}

function readLastAgentCommandCall():
  | {
      message?: string;
      sessionId?: string;
    }
  | undefined {
  return mocks.agentCommand.mock.calls.at(-1)?.[0] as
    | { message?: string; sessionId?: string }
    | undefined;
}

function mockSessionResetSuccess(params: {
  reason: "new" | "reset";
  key?: string;
  sessionId?: string;
}) {
  const key = params.key ?? "agent:main:main";
  const sessionId = params.sessionId ?? "reset-session-id";
  mocks.performGatewaySessionReset.mockImplementation(
    async (opts: { key: string; reason: string; commandSource: string }) => {
      expect(opts.key).toBe(key);
      expect(opts.reason).toBe(params.reason);
      expect(opts.commandSource).toBe("gateway:agent");
      return {
        ok: true,
        key,
        entry: { sessionId },
      };
    },
  );
}

async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
    client?: AgentHandlerArgs["client"];
    isWebchatConnect?: AgentHandlerArgs["isWebchatConnect"];
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers.agent({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
    client: options?.client ?? null,
    isWebchatConnect: options?.isWebchatConnect ?? (() => false),
  });
  return respond;
}

async function invokeAgentIdentityGet(
  params: AgentIdentityGetParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers["agent.identity.get"]({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: {
      type: "req",
      id: options?.reqId ?? "agent-identity-test-req",
      method: "agent.identity.get",
    },
    client: null,
    isWebchatConnect: () => false,
  });
  return respond;
}

describe("gateway agent handler", () => {
  // Ensure fake timers are always restored, even if a test fails mid-execution
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves ACP metadata from the current stored session entry", async () => {
    const existingAcpMeta = {
      backend: "acpx",
      agent: "codex",
      runtimeSessionName: "runtime-1",
      mode: "persistent",
      state: "idle",
      lastActivityAt: Date.now(),
    };

    mockMainSessionEntry({
      acp: existingAcpMeta,
    });

    const getCapturedEntry = captureUpdatedMainEntry(
      buildExistingMainStoreEntry({ acp: existingAcpMeta }),
    );

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-acp-meta");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    const capturedEntry = getCapturedEntry();
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.acp).toEqual(existingAcpMeta);
  });

  /**
   * Test for issue #5369: Verify that modelOverride from sessions.patch is preserved.
   *
   * When sessions.patch sets a modelOverride on a session, the agent handler
   * must use the fresh store data (not potentially stale cached data) when
   * building the session entry.
   *
   * This test simulates:
   * 1. loadSessionEntry returning stale data (no modelOverride) - cache hit
   * 2. updateSessionStore's store having fresh data (with modelOverride)
   * 3. The mutator should use the fresh modelOverride, not the stale one
   */
  it("issue #5369: agent handler preserves fresh modelOverride from store", async () => {
    // Simulate stale cache: loadSessionEntry returns entry WITHOUT modelOverride
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000, // Slightly older
        // NO modelOverride - simulating stale cache read
      },
      canonicalKey: "agent:main:subagent:test-uuid",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      // Simulate fresh store read inside updateSessionStore (with skipCache: true)
      // This store HAS the modelOverride that sessions.patch just wrote
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-uuid": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          modelOverride: "qwen3-coder:30b", // Fresh data from sessions.patch
          providerOverride: "ollama",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-uuid"];
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "test subagent task",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-uuid",
        idempotencyKey: "test-model-override-race",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "race-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();

    // CORRECT BEHAVIOR: modelOverride should be preserved from fresh store
    expect(capturedEntry?.modelOverride).toBe("qwen3-coder:30b");
    expect(capturedEntry?.providerOverride).toBe("ollama");
  });

  /**
   * Test that request values (label, spawnedBy) override store values.
   * This ensures the fix correctly prioritizes request params over fresh store data.
   */
  it("issue #5369: request params override fresh store values for label/spawnedBy", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "subagent-session-id",
        updatedAt: Date.now() - 1000,
        label: "old-label-from-cache",
        spawnedBy: "old-spawner",
      },
      canonicalKey: "agent:main:subagent:test-priority",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:test-priority": {
          sessionId: "subagent-session-id",
          updatedAt: Date.now(),
          label: "store-label",
          spawnedBy: "store-spawner",
          modelOverride: "gpt-4", // Should be preserved
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:test-priority"];
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "test",
        agentId: "main",
        sessionKey: "agent:main:subagent:test-priority",
        idempotencyKey: "test-priority",
        label: "request-label", // Should take precedence
        spawnedBy: "request-spawner", // Should take precedence
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "priority-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(capturedEntry).toBeDefined();
    // Request values should override store values
    expect(capturedEntry?.label).toBe("request-label");
    expect(capturedEntry?.spawnedBy).toBe("agent:main:request-spawner");
    // But modelOverride should still come from fresh store
    expect(capturedEntry?.modelOverride).toBe("gpt-4");
  });

  /**
   * Test that a new session entry is created correctly when store has no entry.
   */
  it("issue #5369: creates new entry when store has no existing entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: undefined, // No existing entry
      canonicalKey: "agent:main:subagent:new-session",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      // Fresh store also has no entry - brand new session
      const freshStore: Record<string, Record<string, unknown>> = {};
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:new-session"];
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "test new session",
        agentId: "main",
        sessionKey: "agent:main:subagent:new-session",
        idempotencyKey: "test-new-session",
        label: "new-label",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "new-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.sessionId).toBeDefined(); // Should generate a sessionId
    expect(capturedEntry?.label).toBe("new-label");
    expect(capturedEntry?.modelOverride).toBeUndefined(); // No override for new session
  });

  /**
   * Test that all important fields are preserved from fresh store.
   */
  it("issue #5369: preserves all important fields from fresh store", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "session-id",
        updatedAt: Date.now() - 1000,
        // Stale data - missing all the fields
      },
      canonicalKey: "agent:main:subagent:all-fields",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const freshStore: Record<string, Record<string, unknown>> = {
        "agent:main:subagent:all-fields": {
          sessionId: "session-id",
          updatedAt: Date.now(),
          thinkingLevel: "high",
          verboseLevel: "detailed",
          reasoningLevel: "on",
          systemSent: true,
          sendPolicy: "allow",
          skillsSnapshot: { tools: ["bash"] },
          modelOverride: "claude-opus",
          providerOverride: "anthropic",
          cliSessionIds: { "claude-cli": "xyz" },
          claudeCliSessionId: "xyz",
        },
      };
      const result = await updater(freshStore);
      capturedEntry = freshStore["agent:main:subagent:all-fields"];
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "test all fields",
        agentId: "main",
        sessionKey: "agent:main:subagent:all-fields",
        idempotencyKey: "test-all-fields",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "all-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(capturedEntry).toBeDefined();
    // All fields should be preserved from fresh store
    expect(capturedEntry?.thinkingLevel).toBe("high");
    expect(capturedEntry?.verboseLevel).toBe("detailed");
    expect(capturedEntry?.reasoningLevel).toBe("on");
    expect(capturedEntry?.systemSent).toBe(true);
    expect(capturedEntry?.sendPolicy).toBe("allow");
    expect(capturedEntry?.skillsSnapshot).toEqual({ tools: ["bash"] });
    expect(capturedEntry?.modelOverride).toBe("claude-opus");
    expect(capturedEntry?.providerOverride).toBe("anthropic");
    expect(capturedEntry?.cliSessionIds).toEqual({ "claude-cli": "xyz" });
    expect(capturedEntry?.claudeCliSessionId).toBe("xyz");
  });

  it("preserves cliSessionIds from existing session entry", async () => {
    const existingCliSessionIds = { "claude-cli": "abc-123-def" };
    const existingClaudeCliSessionId = "abc-123-def";

    mockMainSessionEntry({
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

    const getCapturedEntry = captureUpdatedMainEntry(
      buildExistingMainStoreEntry({
        cliSessionIds: existingCliSessionIds,
        claudeCliSessionId: existingClaudeCliSessionId,
      }),
    );

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    const capturedEntry = getCapturedEntry();
    expect(capturedEntry).toBeDefined();
    expect(capturedEntry?.cliSessionIds).toEqual(existingCliSessionIds);
    expect(capturedEntry?.claudeCliSessionId).toBe(existingClaudeCliSessionId);
  });

  it("injects a timestamp into the message passed to agentCommand", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");

    primeMainAgentRun({ cfg: mocks.loadConfigReturn });

    captureUpdatedMainEntry(buildExistingMainStoreEntry());

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      { reqId: "ts-1" },
    );

    // Wait for the async agentCommand call
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

    resetTimeConfig();
  });

  it.each([
    {
      name: "passes senderIsOwner=false for write-scoped gateway callers",
      scopes: ["operator.write"],
      idempotencyKey: "test-sender-owner-write",
      senderIsOwner: false,
    },
    {
      name: "passes senderIsOwner=true for admin-scoped gateway callers",
      scopes: ["operator.admin"],
      idempotencyKey: "test-sender-owner-admin",
      senderIsOwner: true,
    },
  ])("$name", async ({ scopes, idempotencyKey, senderIsOwner }) => {
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "owner-tools check",
        sessionKey: "agent:main:main",
        idempotencyKey,
      },
      {
        client: {
          connect: {
            role: "operator",
            scopes,
            client: { id: "test-client", mode: "gateway" },
          },
        } as unknown as AgentHandlerArgs["client"],
      },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { senderIsOwner?: boolean }
      | undefined;
    expect(callArgs?.senderIsOwner).toBe(senderIsOwner);
  });

  it("respects explicit bestEffortDeliver=false for main session runs", async () => {
    mocks.agentCommand.mockClear();
    primeMainAgentRun();

    await invokeAgent(
      {
        message: "strict delivery",
        agentId: "main",
        sessionKey: "agent:main:main",
        deliver: true,
        replyChannel: "telegram",
        to: "123",
        bestEffortDeliver: false,
        idempotencyKey: "test-strict-delivery",
      },
      { reqId: "strict-1" },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(callArgs.bestEffortDeliver).toBe(false);
  });

  it("rejects public spawned-run metadata fields", async () => {
    primeMainAgentRun();
    mocks.agentCommand.mockClear();
    const respond = vi.fn();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        spawnedBy: "agent:main:subagent:parent",
        workspaceDir: "/tmp/injected",
        idempotencyKey: "workspace-rejected",
      } as AgentParams,
      { reqId: "workspace-rejected-1", respond },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("invalid agent params"),
      }),
    );
  });

  it("only forwards workspaceDir for spawned sessions with stored workspace inheritance", async () => {
    primeMainAgentRun();
    mockMainSessionEntry({
      spawnedBy: "agent:main:subagent:parent",
      spawnedWorkspaceDir: "/tmp/inherited",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          spawnedBy: "agent:main:subagent:parent",
          spawnedWorkspaceDir: "/tmp/inherited",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockClear();

    await invokeAgent(
      {
        message: "spawned run",
        sessionKey: "agent:main:main",
        idempotencyKey: "workspace-forwarded",
      },
      { reqId: "workspace-forwarded-1" },
    );
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const spawnedCall = mocks.agentCommand.mock.calls.at(-1)?.[0] as { workspaceDir?: string };
    expect(spawnedCall.workspaceDir).toBe("/tmp/inherited");
  });

  it("keeps origin messageChannel as webchat while delivery channel uses last session channel", async () => {
    mockMainSessionEntry({
      sessionId: "existing-session-id",
      lastChannel: "telegram",
      lastTo: "12345",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": buildExistingMainStoreEntry({
          lastChannel: "telegram",
          lastTo: "12345",
        }),
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "webchat turn",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-webchat-origin-channel",
      },
      {
        reqId: "webchat-origin-1",
        client: {
          connect: {
            client: { id: "webchat-ui", mode: "webchat" },
          },
        } as AgentHandlerArgs["client"],
        isWebchatConnect: () => true,
      },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    const callArgs = mocks.agentCommand.mock.calls.at(-1)?.[0] as {
      channel?: string;
      messageChannel?: string;
      runContext?: { messageChannel?: string };
    };
    expect(callArgs.channel).toBe("telegram");
    expect(callArgs.messageChannel).toBe("webchat");
    expect(callArgs.runContext?.messageChannel).toBe("webchat");
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const capturedEntry = await runMainAgentAndCaptureEntry("test-idem-2");
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
  });

  it("prunes legacy main alias keys when writing a canonical session entry", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {
        session: { mainKey: "work" },
        agents: { list: [{ id: "main", default: true }] },
      },
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:work",
    });

    let capturedStore: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:work": { sessionId: "existing-session-id", updatedAt: 10 },
        "agent:main:MAIN": { sessionId: "legacy-session-id", updatedAt: 5 },
      };
      const result = await updater(store);
      capturedStore = store;
      return result;
    });

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "test",
        agentId: "main",
        sessionKey: "main",
        idempotencyKey: "test-idem-alias-prune",
      },
      { reqId: "3" },
    );

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedStore).toBeDefined();
    expect(capturedStore?.["agent:main:work"]).toBeDefined();
    expect(capturedStore?.["agent:main:MAIN"]).toBeUndefined();
  });

  it("handles bare /new by resetting the same session and sending reset greeting prompt", async () => {
    mockSessionResetSuccess({ reason: "new" });

    primeMainAgentRun({ sessionId: "reset-session-id" });

    await invokeAgent(
      {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      { reqId: "4" },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.performGatewaySessionReset).toHaveBeenCalledTimes(1);
    const call = readLastAgentCommandCall();
    // Message is now dynamically built with current date — check key substrings
    expect(call?.message).toContain("Run your Session Startup sequence");
    expect(call?.message).toContain("Current time:");
    expect(call?.message).not.toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
  });

  it("uses /reset suffix as the post-reset message and still injects timestamp", async () => {
    setupNewYorkTimeConfig("2026-01-29T01:30:00.000Z");
    mockSessionResetSuccess({ reason: "reset" });
    mocks.performGatewaySessionReset.mockClear();
    primeMainAgentRun({
      sessionId: "reset-session-id",
      cfg: mocks.loadConfigReturn,
    });

    await invokeAgent(
      {
        message: "/reset check status",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-reset-suffix",
      },
      { reqId: "4b" },
    );

    const call = await expectResetCall("[Wed 2026-01-28 20:30 EST] check status");
    expect(call?.sessionId).toBe("reset-session-id");

    resetTimeConfig();
  });

  it("rejects malformed agent session keys early in agent handler", async () => {
    mocks.agentCommand.mockClear();
    const respond = await invokeAgent(
      {
        message: "test",
        sessionKey: "agent:main",
        idempotencyKey: "test-malformed-session-key",
      },
      { reqId: "4" },
    );

    expect(mocks.agentCommand).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });

  it("rejects malformed session keys in agent.identity.get", async () => {
    const respond = await invokeAgentIdentityGet(
      {
        sessionKey: "agent:main",
      },
      { reqId: "5" },
    );

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("malformed session key"),
      }),
    );
  });
});
