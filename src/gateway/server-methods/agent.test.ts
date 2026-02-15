import { describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "./types.js";
import { BARE_SESSION_RESET_PROMPT } from "../../auto-reply/reply/session-reset-prompt.js";
import { agentHandlers } from "./agent.js";

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

describe("gateway agent handler", () => {
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
      const store: Record<string, unknown> = {};
      await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
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
    mocks.updateSessionStore.mockResolvedValue(undefined);
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
      const store: Record<string, unknown> = {};
      await updater(store);
      capturedEntry = store["agent:main:main"] as Record<string, unknown>;
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
      await updater(store);
      capturedStore = store;
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
        sessionKey: "main",
        idempotencyKey: "test-idem-alias-prune",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "3", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

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
    mocks.updateSessionStore.mockResolvedValue(undefined);
    mocks.agentCommand.mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: { durationMs: 100 },
    });

    const respond = vi.fn();
    await agentHandlers.agent({
      params: {
        message: "/new",
        sessionKey: "agent:main:main",
        idempotencyKey: "test-idem-new",
      },
      respond,
      context: makeContext(),
      req: { type: "req", id: "4", method: "agent" },
      client: null,
      isWebchatConnect: () => false,
    });

    await vi.waitFor(() => expect(mocks.agentCommand).toHaveBeenCalled());
    expect(mocks.sessionsResetHandler).toHaveBeenCalledTimes(1);
    const call = mocks.agentCommand.mock.calls.at(-1)?.[0] as
      | { message?: string; sessionId?: string }
      | undefined;
    expect(call?.message).toBe(BARE_SESSION_RESET_PROMPT);
    expect(call?.sessionId).toBe("reset-session-id");
  });
});
