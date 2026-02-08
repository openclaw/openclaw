import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { agentHandlers } from "./agent.js";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
  updateSessionStore: vi.fn(),
  agentCommand: vi.fn(),
  registerAgentRunContext: vi.fn(),
  loadConfigReturn: {} as Record<string, unknown>,
}));

vi.mock("../session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

vi.mock("../../config/sessions.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions.js")>(
    "../../config/sessions.js",
  );
  return {
    ...actual,
    updateSessionStore: mocks.updateSessionStore,
    resolveAgentIdFromSessionKey: () => "main",
    resolveExplicitAgentSessionKey: () => undefined,
    resolveAgentMainSessionKey: () => "agent:main:main",
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
    expect(capturedEntry?.spawnedBy).toBe("request-spawner");
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

    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
        cliSessionIds: existingCliSessionIds,
        claudeCliSessionId: existingClaudeCliSessionId,
      },
      canonicalKey: "agent:main:main",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      // Provide fresh store with the entry data (simulating skipCache: true read)
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": {
          sessionId: "existing-session-id",
          updatedAt: Date.now(),
          cliSessionIds: existingCliSessionIds,
          claudeCliSessionId: existingClaudeCliSessionId,
        },
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"];
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
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.updateSessionStore).toHaveBeenCalled();
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

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "Is it the weekend?",
        agentId: "main",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-timestamp-inject",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "ts-1", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    // Wait for the async agentCommand call
    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());

    const callArgs = mocks.agentCommand.mock.calls[0][0];
    expect(callArgs.message).toBe("[Wed 2026-01-28 20:30 EST] Is it the weekend?");

    mocks.loadConfigReturn = {};
    vi.useRealTimers();
  });

  it("handles missing cliSessionIds gracefully", async () => {
    mocks.loadSessionEntry.mockReturnValue({
      cfg: {},
      storePath: "/tmp/sessions.json",
      entry: {
        sessionId: "existing-session-id",
        updatedAt: Date.now(),
        // No cliSessionIds or claudeCliSessionId
      },
      canonicalKey: "agent:main:main",
    });

    let capturedEntry: Record<string, unknown> | undefined;
    mocks.updateSessionStore.mockImplementation(async (_path, updater) => {
      // Provide fresh store with entry data (no cliSessionIds)
      const store: Record<string, Record<string, unknown>> = {
        "agent:main:main": {
          sessionId: "existing-session-id",
          updatedAt: Date.now(),
          // No cliSessionIds or claudeCliSessionId
        },
      };
      const result = await updater(store);
      capturedEntry = store["agent:main:main"];
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
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-2",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "2", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(mocks.updateSessionStore).toHaveBeenCalled();
    expect(capturedEntry).toBeDefined();
    // Should be undefined, not cause an error
    expect(capturedEntry?.cliSessionIds).toBeUndefined();
    expect(capturedEntry?.claudeCliSessionId).toBeUndefined();
  });
});
