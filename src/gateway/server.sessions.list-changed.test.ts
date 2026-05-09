import { expect, test, vi } from "vitest";
import { createSqliteSessionTranscriptLocator } from "../config/sessions/test-helpers/transcript-locator.js";
import { replaceSqliteSessionTranscriptEvents } from "../config/sessions/transcript-store.sqlite.js";
import { rpcReq, testState, seedGatewaySessionEntries } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
  createDeferred,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

function sqliteTranscript(sessionId: string): string {
  return createSqliteSessionTranscriptLocator({ agentId: "main", sessionId });
}

test("sessions.list keeps bulk rows lightweight and uses persisted model fields", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    models: {
      "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
    },
  };
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-parent",
    events: [{ type: "session", version: 1, id: "sess-parent" }],
  });
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-child",
    events: [
      { type: "session", version: 1, id: "sess-child" },
      {
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          usage: {
            input: 2_000,
            output: 500,
            cacheRead: 1_000,
            cost: { total: 0.0042 },
          },
        },
      },
      {
        message: {
          role: "assistant",
          provider: "openclaw",
          model: "delivery-mirror",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    ],
  });
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-parent"),
      "dashboard:child": sessionStoreEntry("sess-child", {
        updatedAt: Date.now() - 1_000,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        parentSessionKey: "agent:main:main",
        totalTokens: 0,
        totalTokensFresh: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    },
  });

  const { ws } = await openClient();
  const listed = await rpcReq<{
    sessions: Array<{
      key: string;
      parentSessionKey?: string;
      childSessions?: string[];
      totalTokens?: number;
      totalTokensFresh?: boolean;
      contextTokens?: number;
      estimatedCostUsd?: number;
      modelProvider?: string;
      model?: string;
    }>;
  }>(ws, "sessions.list", {});

  expect(listed.ok).toBe(true);
  const parent = listed.payload?.sessions.find((session) => session.key === "agent:main:main");
  const child = listed.payload?.sessions.find(
    (session) => session.key === "agent:main:dashboard:child",
  );
  expect(parent?.childSessions).toEqual(["agent:main:dashboard:child"]);
  expect(child?.parentSessionKey).toBe("agent:main:main");
  expect(child?.totalTokens).toBeUndefined();
  expect(child?.totalTokensFresh).toBe(false);
  expect(child?.contextTokens).toBeUndefined();
  expect(child?.estimatedCostUsd).toBeUndefined();
  expect(child?.modelProvider).toBe("anthropic");
  expect(child?.model).toBe("claude-sonnet-4-6");

  ws.close();
});

test("sessions.list uses the gateway model catalog for effective thinking defaults", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: { primary: "test-provider/reasoner" },
  };
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "test-provider",
        model: "reasoner",
      }),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "req-sessions-list-thinking-default",
      method: "sessions.list",
      params: {},
    },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [
        {
          provider: "test-provider",
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
        },
      ],
    } as never,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      defaults: expect.objectContaining({
        thinkingDefault: "medium",
      }),
      sessions: expect.arrayContaining([
        expect.objectContaining({
          key: "agent:main:main",
          thinkingDefault: "medium",
          thinkingOptions: ["off", "minimal", "low", "medium", "high"],
        }),
      ]),
    }),
    undefined,
  );
});

test("sessions.list marks sessions with active abortable runs", async () => {
  await createSessionStoreDir();
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "req-sessions-list-active-run",
      method: "sessions.list",
      params: {},
    },
    params: {},
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      chatAbortControllers: new Map([["run-1", { sessionKey: "agent:main:main" }]]),
    } as never,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          key: "agent:main:main",
          hasActiveRun: true,
        }),
      ]),
    }),
    undefined,
  );
});

test("sessions.list yields before responding during bulk transcript hydration", async () => {
  await createSessionStoreDir();
  const entries: Record<string, ReturnType<typeof sessionStoreEntry>> = {};
  const now = Date.now();
  for (let i = 0; i < 11; i += 1) {
    const sessionId = `sess-list-yield-${i}`;
    entries[`bulk-${i}`] = sessionStoreEntry(sessionId, { updatedAt: now - i });
    replaceSqliteSessionTranscriptEvents({
      agentId: "main",
      sessionId,
      events: [
        { type: "message", message: { role: "user", content: `title ${i}` } },
        { type: "message", message: { role: "assistant", content: `last ${i}` } },
      ],
    });
  }
  await seedGatewaySessionEntries({ entries });

  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const request = sessionsHandlers["sessions.list"]({
    req: {
      type: "req",
      id: "req-sessions-list-yield",
      method: "sessions.list",
      params: {
        includeDerivedTitles: true,
        includeLastMessage: true,
        limit: 11,
      },
    },
    params: {
      includeDerivedTitles: true,
      includeLastMessage: true,
      limit: 11,
    },
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: {
      getRuntimeConfig,
      loadGatewayModelCatalog: async () => [],
      logGateway: {
        debug: vi.fn(),
      },
    } as never,
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(respond).not.toHaveBeenCalled();
  await request;
  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({
      sessions: expect.arrayContaining([
        expect.objectContaining({
          key: "agent:main:bulk-0",
          derivedTitle: "title 0",
          lastMessagePreview: "last 0",
        }),
      ]),
    }),
    undefined,
  );
});

test("sessions.list does not block on slow model catalog discovery", async () => {
  await createSessionStoreDir();
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main"),
    },
  });

  vi.useFakeTimers();
  try {
    const deferredCatalog = createDeferred<never>();
    const respond = vi.fn();
    const sessionsHandlers = await getSessionsHandlers();
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const request = sessionsHandlers["sessions.list"]({
      req: {
        type: "req",
        id: "req-sessions-list-slow-catalog",
        method: "sessions.list",
        params: {},
      },
      params: {},
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: {
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn(() => deferredCatalog.promise),
        logGateway: {
          debug: vi.fn(),
        },
      } as never,
    });

    await vi.advanceTimersByTimeAsync(800);
    await request;

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        sessions: expect.arrayContaining([expect.objectContaining({ key: "agent:main:main" })]),
      }),
      undefined,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("sessions.changed mutation events include live usage metadata", async () => {
  await createSessionStoreDir();
  replaceSqliteSessionTranscriptEvents({
    agentId: "main",
    sessionId: "sess-main",
    events: [
      {
        type: "message",
        id: "msg-usage-zero",
        message: {
          role: "assistant",
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          usage: {
            input: 5_107,
            output: 1_827,
            cacheRead: 1_536,
            cacheWrite: 0,
            cost: { total: 0 },
          },
          timestamp: Date.now(),
        },
      },
    ],
  });
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main", {
        modelProvider: "openai-codex",
        model: "gpt-5.3-codex-spark",
        contextTokens: 123_456,
        totalTokens: 0,
        totalTokensFresh: false,
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "main",
      label: "Renamed",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:main" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:main",
      reason: "patch",
      totalTokens: 6_643,
      totalTokensFresh: true,
      contextTokens: 123_456,
      estimatedCostUsd: 0,
      modelProvider: "openai-codex",
      model: "gpt-5.3-codex-spark",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.changed mutation events include live session setting metadata", async () => {
  await createSessionStoreDir();
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main", {
        verboseLevel: "on",
        responseUsage: "full",
        fastMode: true,
        lastChannel: "telegram",
        lastTo: "-100123",
        lastAccountId: "acct-1",
        lastThreadId: 42,
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "main",
      verboseLevel: "on",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:main" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:main",
      reason: "patch",
      verboseLevel: "on",
      responseUsage: "full",
      fastMode: true,
      lastChannel: "telegram",
      lastTo: "-100123",
      lastAccountId: "acct-1",
      lastThreadId: 42,
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.changed mutation events include sendPolicy metadata", async () => {
  await createSessionStoreDir();
  await seedGatewaySessionEntries({
    entries: {
      main: sessionStoreEntry("sess-main", {
        sendPolicy: "deny",
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "main",
      sendPolicy: "deny",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:main" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:main",
      reason: "patch",
      sendPolicy: "deny",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});

test("sessions.changed mutation events include subagent ownership metadata", async () => {
  await createSessionStoreDir();
  await seedGatewaySessionEntries({
    entries: {
      "subagent:child": sessionStoreEntry("sess-child", {
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/tmp/subagent-workspace",
        forkedFromParent: true,
        spawnDepth: 2,
        subagentRole: "orchestrator",
        subagentControlScope: "children",
      }),
    },
  });

  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  await sessionsHandlers["sessions.patch"]({
    req: {} as never,
    params: {
      key: "subagent:child",
      label: "Child",
    },
    respond,
    context: {
      broadcastToConnIds,
      getSessionEventSubscriberConnIds: () => new Set(["conn-1"]),
      loadGatewayModelCatalog: async () => ({ providers: [] }),
      getRuntimeConfig: getRuntimeConfig,
    } as never,
    client: null,
    isWebchatConnect: () => false,
  });

  expect(respond).toHaveBeenCalledWith(
    true,
    expect.objectContaining({ ok: true, key: "agent:main:subagent:child" }),
    undefined,
  );
  expect(broadcastToConnIds).toHaveBeenCalledWith(
    "sessions.changed",
    expect.objectContaining({
      sessionKey: "agent:main:subagent:child",
      reason: "patch",
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/tmp/subagent-workspace",
      forkedFromParent: true,
      spawnDepth: 2,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
    }),
    new Set(["conn-1"]),
    { dropIfSlow: true },
  );
});
