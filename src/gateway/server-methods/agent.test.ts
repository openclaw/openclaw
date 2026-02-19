import { afterEach, describe, expect, it, vi } from "vitest";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { agentHandlers } from "./agent.js";
import type { GatewayRequestContext } from "./types.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  sessionsResetHandler: vi.fn(),
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
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => mocks.loadConfigReturn,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentIds: () => ["main"],
}));

vi.mock("../../infra/agent-events.js", () => ({
  registerAgentRunContext: mocks.registerAgentRunContext,
  onAgentEvent: vi.fn(),
}));

vi.mock("./sessions.js", () => ({
  sessionsHandlers: {
    "sessions.reset": (...args: unknown[]) =>
      (mocks.sessionsResetHandler as (...args: unknown[]) => unknown)(...args),
  },
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

async function invokeAgent(
  params: AgentParams,
  options?: {
    respond?: ReturnType<typeof vi.fn>;
    reqId?: string;
    context?: GatewayRequestContext;
  },
) {
  const respond = options?.respond ?? vi.fn();
  await agentHandlers.agent({
    params,
    respond: respond as never,
    context: options?.context ?? makeContext(),
    req: { type: "req", id: options?.reqId ?? "agent-test-req", method: "agent" },
    client: null,
    isWebchatConnect: () => false,
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

    const getCapturedEntry = captureUpdatedMainEntry({
      sessionId: "existing-session-id",
      updatedAt: Date.now(),
      cliSessionIds: existingCliSessionIds,
      claudeCliSessionId: existingClaudeCliSessionId,
    });

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
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-29T01:30:00.000Z")); // Wed Jan 28, 8:30 PM EST
    mocks.agentCommand.mockReset();

    mocks.loadConfigReturn = {
      agents: {
        defaults: {
          userTimezone: "America/New_York",
        },
      },
    };

    mocks.loadSessionEntry.mockReturnValue({
      cfg: mocks.loadConfigReturn,
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": {
          sessionId: "existing-session-id",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
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

    mocks.loadConfigReturn = {};
    vi.useRealTimers();
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mockMainSessionEntry({});

    const getCapturedEntry = captureUpdatedMainEntry();

    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await runMainAgent("test", "test-idem-2");

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    const capturedEntry = getCapturedEntry();
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
    mocks.sessionsResetHandler.mockImplementation(
      async (opts: {
        params: { key: string; reason: string };
        respond: (ok: boolean, payload?: unknown) => void;
      }) => {
        expect(opts.params.key).toBe("agent:main:main");
        expect(opts.params.reason).toBe("new");
        opts.respond(true, {
          ok: true,
          key: "agent:main:main",
          entry: { sessionId: "reset-session-id" },
        });
      },
    );

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "reset-session-id",
        updatedAt: Date.now(),
      },
      canonicalKey: "agent:main:main",
    });
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      const store: Record<string, unknown> = {
        "agent:main:main": {
          sessionId: "reset-session-id",
          updatedAt: Date.now(),
        },
      };
      return await updater(store);
    });
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    await invokeAgent(
      {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      { reqId: "4" },
    );

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.sessionsResetHandler).toHaveBeenCalledTimes(1);
    const call = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { message?: string; sessionId?: string }
      | undefined;
    expect(call?.message).toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
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
