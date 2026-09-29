/**
 * Gateway sessions.list changed-state tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { subscribePluginSessionsChanged } from "../plugins/services.test-support.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import { setupPersistentSessionListTestHarness } from "./server.sessions.list-changed.fixture.test-support.js";
import {
  requireRecord,
  requireArray,
  expectFields,
  transcriptMessageContents,
  expectRespondPayload,
  findSession,
  expectChangedBroadcast,
} from "./server.sessions.list-changed.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { observeSessionRowBackfill } from "./session-row-backfill.test-support.js";
import {
  seedCompletedSessionTranscript,
  seedSessionListBackfillFixture,
} from "./session-row-fixtures.test-support.js";
import { getSessionRowProjection } from "./session-row-projection-access.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  getSessionsHandlers,
  loadSeededTranscriptEvents,
  seedSessionTranscript,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  createFreshSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupPersistentSessionListTestHarness();

type SessionStoreEntryOptions = Parameters<typeof sessionStoreEntry>[1];
type MutationMethod = "sessions.patch" | "sessions.compact";

async function invokeSessionsList({
  requestId,
  params = {},
  context = {},
  defer = false,
}: {
  requestId: string;
  params?: Record<string, unknown>;
  context?: Record<string, unknown>;
  defer?: boolean;
}) {
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const requestContext = {
    getRuntimeConfig,
    readPreparedGatewayModelCatalog: async () => ({ entries: [] }),
    ...context,
  } as unknown as GatewayRequestContext;
  const request = initializeSessionReadContext(requestContext).then(() =>
    expectDefined(
      sessionsHandlers["sessions.list"],
      'sessionsHandlers["sessions.list"] test invariant',
    )({
      req: {
        type: "req",
        id: requestId,
        method: "sessions.list",
        params,
      },
      params,
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: requestContext,
    }),
  );
  if (!defer) {
    await request;
  }
  return { request, respond, context: requestContext };
}

async function mutationCatalogSnapshot(
  entries: ModelCatalogEntry[],
): Promise<GatewayModelCatalogSnapshot> {
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const config = getRuntimeConfig();
  return {
    entries,
    routeVariants: entries,
    agentId: "main",
    agentDir: resolveAgentDir(config, "main"),
    workspaceDir: resolveAgentWorkspaceDir(config, "main"),
    config,
    catalogComplete: true,
  };
}

async function invokeSessionMutation({
  method,
  params,
  context = {},
  subscribedConnIds = new Set(["conn-1"]),
}: {
  method: MutationMethod;
  params: Record<string, unknown>;
  context?: Record<string, unknown>;
  subscribedConnIds?: Set<string>;
}) {
  const broadcastToConnIds = vi.fn();
  const respond = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const requestContext = {
    broadcastToConnIds,
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => subscribedConnIds,
    loadGatewayModelCatalog: async () => ({ providers: [] }),
    loadGatewayModelCatalogSnapshot: () => mutationCatalogSnapshot([]),
    getRuntimeConfig,
    ...context,
  } as unknown as GatewayRequestContext;
  await initializeSessionReadContext(requestContext);
  await expectDefined(
    sessionsHandlers[method],
    "sessionsHandlers[method] test invariant",
  )({
    req: {} as never,
    params,
    respond,
    context: requestContext,
    client: null,
    isWebchatConnect: () => false,
  });
  await flushPendingSessionsChangedEvents(requestContext);
  return {
    broadcastToConnIds,
    responsePayload: expectRespondPayload(respond),
  };
}

async function invokeSessionsPatch(params: Record<string, unknown>) {
  return invokeSessionMutation({ method: "sessions.patch", params });
}

async function writeMainSessionStore(options?: SessionStoreEntryOptions) {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-main", options),
    },
  });
}

function expectMainPatchBroadcast(
  result: Awaited<ReturnType<typeof invokeSessionsPatch>>,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  expectFields(result.responsePayload, { ok: true, key: "agent:main:main" });
  return expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    ...expected,
  });
}

async function invokeSessionsCompact({
  getRuntimeConfig,
  params,
  subscribedConnIds = new Set(["conn-1"]),
}: {
  getRuntimeConfig: unknown;
  params: Record<string, unknown>;
  subscribedConnIds?: Set<string>;
}) {
  return invokeSessionMutation({
    method: "sessions.compact",
    params,
    context: {
      getRuntimeConfig,
    },
    subscribedConnIds,
  });
}

test("sessions.list uses persisted usage and selected model fields", async () => {
  const { storePath } = await createFreshSessionStoreDir();
  testState.agentConfig = {
    models: {
      "anthropic/claude-sonnet-4-6": { params: { context1m: true } },
    },
  };
  await seedCompletedSessionTranscript({
    storePath,
    sessionId: "sess-child",
    sessionKey: "agent:main:dashboard:child",
    entries: {
      main: sessionStoreEntry("sess-parent"),
      "dashboard:child": sessionStoreEntry("sess-child", {
        updatedAt: Date.now() - 1_000,
        providerOverride: "anthropic",
        modelOverride: "test-model-without-catalog-context",
        modelProvider: "anthropic",
        model: "test-model-without-catalog-context",
        modelSelectionLocked: true,
        parentSessionKey: "agent:main:main",
        totalTokens: 0,
        totalTokensFresh: false,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }),
    },
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
    trailingMessages: [
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
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
      modelSelectionLocked?: boolean;
    }>;
  }>(ws, "sessions.list", {});

  expect(listed.ok).toBe(true);
  const parent = listed.payload?.sessions.find((session) => session.key === "agent:main:main");
  const child = listed.payload?.sessions.find(
    (session) => session.key === "agent:main:dashboard:child",
  );
  expect(parent?.childSessions).toEqual(["agent:main:dashboard:child"]);
  expect(child?.parentSessionKey).toBe("agent:main:main");
  expect(child?.totalTokens).toBe(3_000);
  expect(child?.totalTokensFresh).toBe(true);
  expect(child?.contextTokens).toBeUndefined();
  expect(child?.estimatedCostUsd).toBe(0.0042);
  expect(child?.modelProvider).toBe("anthropic");
  expect(child?.model).toBe("test-model-without-catalog-context");
  expect(child?.modelSelectionLocked).toBe(true);

  ws.close();
});

test.each([["my-ngc:nvidia", "nvidia/nemotron-3-ultra-550b-a55b"]])(
  "sessions.list preserves selected custom provider %s and nested models over WebSocket",
  async (provider, model) => {
    const { storePath } = await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-parent"),
        "dashboard:child": sessionStoreEntry("sess-custom-provider", {
          providerOverride: provider,
          modelOverride: model,
          modelProvider: provider,
          model,
          parentSessionKey: "agent:main:main",
        }),
      },
    });
    await seedSessionTranscript({
      sessionId: "sess-custom-provider",
      sessionKey: "agent:main:dashboard:child",
      storePath,
      messages: [
        {
          role: "user",
          content: `List ${provider}/${model} sessions.`,
        },
        {
          role: "assistant",
          provider,
          model,
          content: `${provider} remains a model provider, not a plugin directory.`,
        },
      ],
    });

    const { ws } = await openClient();
    const listed = await rpcReq<{
      sessions: Array<{ key: string; modelProvider?: string; model?: string }>;
    }>(ws, "sessions.list", {});
    ws.close();

    expect(listed.ok, JSON.stringify(listed)).toBe(true);
    expect(
      listed.payload?.sessions.find((session) => session.key === "agent:main:dashboard:child"),
    ).toMatchObject({
      modelProvider: provider,
      model,
    });
  },
);

test.each(["gpt-5.6-sol"])(
  "sessions.patch returns authoritative native Codex Ultra metadata for %s",
  async (model) => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "openai",
      source: "test",
      provider: {
        id: "openai",
        label: "OpenAI",
        auth: [],
        resolveThinkingProfile: ({ compat }) => ({
          levels: [
            { id: "off" },
            { id: "high" },
            { id: "max" },
            ...(compat?.supportedReasoningEfforts?.includes("ultra")
              ? [{ id: "ultra" as const }]
              : []),
          ],
          defaultLevel: "high",
        }),
      },
    });
    setActivePluginRegistry(registry);
    testState.agentConfig = {
      model: { primary: `openai/${model}` },
      models: {
        [`openai/${model}`]: { agentRuntime: { id: "codex" } },
      },
    };
    await writeMainSessionStore({ modelProvider: "openai", model });
    const loadGatewayModelCatalogSnapshot = vi.fn(async () =>
      mutationCatalogSnapshot([
        {
          provider: "openai",
          id: model,
          name: model,
          reasoning: true,
          compat: {
            supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
          },
        },
      ]),
    );

    const result = await invokeSessionMutation({
      method: "sessions.patch",
      params: { key: "main", thinkingLevel: "ultra" },
      context: { loadGatewayModelCatalogSnapshot },
    });

    const resolved = requireRecord(result.responsePayload.resolved, "resolved patch metadata");
    expectFields(resolved, {
      modelProvider: "openai",
      model,
      thinkingLevel: "ultra",
    });
    expect(requireRecord(resolved.agentRuntime, "resolved agent runtime").id).toBe("codex");
    expect(
      requireArray(resolved.thinkingLevels, "resolved thinking levels").map(
        (level) => requireRecord(level, "thinking level").id,
      ),
    ).toContain("ultra");
    expect(loadGatewayModelCatalogSnapshot).toHaveBeenCalledTimes(1);

    const event = expectChangedBroadcast(result.broadcastToConnIds, {
      sessionKey: "agent:main:main",
      reason: "patch",
      thinkingLevel: "ultra",
    });
    expect(event).not.toHaveProperty("thinkingLevels");
    expect(event).not.toHaveProperty("thinkingOptions");
    expect(event).not.toHaveProperty("thinkingDefault");
  },
);

test("sessions.patch omits thinking metadata when an unrelated patch skips the catalog", async () => {
  testState.agentConfig = {
    model: { primary: "synthetic/plain" },
  };
  await writeMainSessionStore({
    modelProvider: "synthetic",
    model: "plain",
    thinkingLevel: "max",
  });
  const loadGatewayModelCatalogSnapshot = vi.fn(async () =>
    mutationCatalogSnapshot([
      {
        provider: "synthetic",
        id: "plain",
        name: "plain",
        reasoning: false,
      },
    ]),
  );

  const result = await invokeSessionMutation({
    method: "sessions.patch",
    params: { key: "main", label: "Renamed" },
    context: { loadGatewayModelCatalogSnapshot },
  });

  const resolved = requireRecord(result.responsePayload.resolved, "resolved patch metadata");
  expect(resolved).not.toHaveProperty("thinkingLevel");
  expect(resolved).not.toHaveProperty("thinkingLevels");
  expect(loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
  expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    thinkingLevel: "max",
  });
});

test("sessions.changed mutations reach plugin subscribers without websocket clients", async () => {
  await writeMainSessionStore({ label: "Original title" });
  const received = vi.fn();
  const unsubscribe = subscribePluginSessionsChanged(received);
  const { broadcastToConnIds } = createGatewayBroadcaster({ clients: new GatewayClientRegistry() });

  try {
    await invokeSessionMutation({
      method: "sessions.patch",
      params: { key: "main", label: "Renamed title" },
      subscribedConnIds: new Set(),
      context: { broadcastToConnIds },
    });

    await vi.waitFor(() => {
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:main",
          label: "Renamed title",
          reason: "patch",
        }),
      );
    });
  } finally {
    unsubscribe();
  }
});

test("sessions.list distinguishes proven idle from unavailable run identities", async () => {
  await writeMainSessionStore();

  const idle = await invokeSessionsList({ requestId: "req-sessions-list-idle-exact-runs" });
  const idleSession = findSession(expectRespondPayload(idle.respond), "agent:main:main");
  expect(idleSession).toMatchObject({ hasActiveRun: false, activeRunIds: [] });

  const runId = "list-unavailable-exact-identities";
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    projectSessionActive: true,
  });
  try {
    const unavailable = await invokeSessionsList({
      requestId: "req-sessions-list-unavailable-runs",
    });
    const unavailableSession = findSession(
      expectRespondPayload(unavailable.respond),
      "agent:main:main",
    );
    expect(unavailableSession).toMatchObject({ hasActiveRun: true });
    expect(unavailableSession).not.toHaveProperty("activeRunIds");
  } finally {
    clearAgentRunContext(runId);
  }
});

test("sessions.changed publishes running status during ordinary startup", async () => {
  await writeMainSessionStore({ status: "failed" });
  const result = await invokeSessionMutation({
    method: "sessions.patch",
    params: { key: "main", label: "Starting main" },
    context: {
      chatAbortControllers: new Map([
        ["run-1", { sessionKey: "agent:main:main", executionStarted: false }],
      ]),
    },
  });

  expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    status: "running",
    hasActiveRun: true,
    activeRunIds: ["run-1"],
  });
});

test("sessions.list leaves failed-first-turn dashboard sessions untitled instead of an id-prefix title", async () => {
  const sessionKey = "agent:main:dashboard:fade729d-1111-2222-3333-444455556666";
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "dashboard:fade729d-1111-2222-3333-444455556666": sessionStoreEntry("sess-dash-untitled"),
    },
  });
  await seedSessionTranscript({
    sessionId: "sess-dash-untitled",
    sessionKey,
    storePath,
    messages: [{ role: "assistant", content: "The first turn failed before a user message." }],
  });

  const { respond } = await invokeSessionsList({
    requestId: "req-sessions-list-untitled-dashboard",
    params: { includeDerivedTitles: true },
  });

  const session = findSession(expectRespondPayload(respond), sessionKey);
  expect(session.derivedTitle).toBeUndefined();
});

test("sessions.list yields for bulk metadata and later serves previews without repairing titles", async () => {
  const { storePath } = await createSessionStoreDir();
  const keys = await seedSessionListBackfillFixture(storePath, 11);
  const releaseForeground = retainSessionListForegroundWork();
  try {
    const params = { includeDerivedTitles: true, includeLastMessage: true, limit: 11 };
    const { request, respond, context } = await invokeSessionsList({
      requestId: "req-sessions-list-yield",
      defer: true,
      params,
      context: {
        logGateway: {
          debug: vi.fn(),
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(respond).not.toHaveBeenCalled();
    await request;
    expectRespondPayload(respond);
    const projection = expectDefined(getSessionRowProjection(context), "request projection");
    const backfilled = observeSessionRowBackfill(keys, projection);
    releaseForeground();
    await backfilled;
    const refreshed = await invokeSessionsList({
      requestId: "req-sessions-list-backfilled",
      params,
      context: { ...context },
    });
    const payload = expectRespondPayload(refreshed.respond);
    const session = findSession(payload, "agent:main:bulk-0");
    expectFields(session, {
      derivedTitle: undefined,
      lastMessagePreview: "last 0",
    });
  } finally {
    releaseForeground();
  }
});

test("sessions.changed includes live usage metadata without inventing an unpriced cost", async () => {
  const { storePath } = await createSessionStoreDir();
  await seedCompletedSessionTranscript({
    storePath,
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    entries: {
      main: sessionStoreEntry("sess-main", {
        providerOverride: "openai",
        modelOverride: "test-unpriced-model",
        modelProvider: "openai",
        model: "test-unpriced-model",
        agentHarnessId: "openclaw",
        contextTokens: 123_456,
        contextTokensSource: "runtime",
        totalTokens: 0,
        totalTokensFresh: false,
      }),
    },
    message: {
      role: "assistant",
      provider: "openai",
      model: "test-unpriced-model",
      usage: {
        input: 5_107,
        output: 1_827,
        cacheRead: 1_536,
        cacheWrite: 0,
        cost: { total: 0 },
      },
      timestamp: Date.now(),
    },
  });

  const result = await invokeSessionsPatch({
    key: "main",
    label: "Renamed",
  });

  expectMainPatchBroadcast(result, {
    totalTokens: 6_643,
    totalTokensFresh: true,
    contextTokens: 123_456,
    estimatedCostUsd: undefined,
    modelProvider: "openai",
    model: "test-unpriced-model",
  });
});

test("sessions.changed mutation events carry the resolved effectiveResponseUsage when the session has no override", async () => {
  // No explicit responseUsage and no configured default → the row builder resolves
  // effectiveResponseUsage to "off". The event must carry that resolved value, not
  // the absent raw responseUsage, so a UI consumer's effective display stays fresh.
  await writeMainSessionStore({ verboseLevel: "on" });

  const result = await invokeSessionsPatch({
    key: "main",
    verboseLevel: "on",
  });

  const payload = expectMainPatchBroadcast(result, {
    effectiveResponseUsage: "off",
  });
  // Raw responseUsage is genuinely absent (no override), proving the event does not
  // merely echo the raw field.
  expect(payload.responseUsage).toBeUndefined();
});

test("sessions.changed mutation events include session management metadata", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "discord:group:dev": sessionStoreEntry("sess-dev", {
        pinnedAt: 10,
        lastReadAt: 20,
        lastActivityAt: 5,
      }),
    },
  });

  const archived = await invokeSessionsPatch({
    key: "discord:group:dev",
    expectedSessionId: "sess-dev",
    archived: true,
  });
  expectChangedBroadcast(archived.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    archived: true,
    archivedAt: expect.any(Number),
    pinned: false,
    pinnedAt: null,
    unread: false,
    lastReadAt: 20,
    lastActivityAt: 5,
  });

  const restored = await invokeSessionsPatch({
    key: "discord:group:dev",
    expectedSessionId: "sess-dev",
    archived: false,
  });
  expectChangedBroadcast(restored.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    archived: false,
    archivedAt: null,
  });

  const pinned = await invokeSessionsPatch({
    key: "discord:group:dev",
    pinned: true,
  });
  expectChangedBroadcast(pinned.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    pinned: true,
    pinnedAt: expect.any(Number),
  });

  const unpinned = await invokeSessionsPatch({
    key: "discord:group:dev",
    pinned: false,
  });
  expectChangedBroadcast(unpinned.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    pinned: false,
    pinnedAt: null,
  });

  const unread = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: true,
  });
  const unreadPayload = expectChangedBroadcast(unread.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    unread: true,
    lastReadAt: 20,
    markedUnreadAt: expect.any(Number),
    lastActivityAt: 5,
  });

  const marker = expectDefined(
    unreadPayload.markedUnreadAt as number | undefined,
    "manual unread marker",
  );
  expect(marker).toEqual(expect.any(Number));

  const staleRead = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: false,
    expectedMarkedUnreadAt: null,
  });
  expectFields(staleRead.responsePayload, { ok: true, key: "agent:main:discord:group:dev" });
  expect(staleRead.broadcastToConnIds).not.toHaveBeenCalled();
  expect(requireRecord(staleRead.responsePayload.entry, "stale read entry").markedUnreadAt).toBe(
    marker,
  );

  const read = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: false,
    expectedMarkedUnreadAt: marker,
  });
  expectChangedBroadcast(read.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    unread: false,
    lastReadAt: expect.any(Number),
    markedUnreadAt: null,
    lastActivityAt: 5,
  });

  const remarked = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: true,
  });
  expectChangedBroadcast(remarked.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    unread: true,
    markedUnreadAt: expect.any(Number),
  });

  const legacyRead = await invokeSessionsPatch({
    key: "discord:group:dev",
    unread: false,
  });
  expectChangedBroadcast(legacyRead.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    unread: false,
    lastReadAt: expect.any(Number),
    markedUnreadAt: null,
    lastActivityAt: 5,
  });
});

test("sessions.patch scopes selected global mutations and events to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });

  const { broadcastToConnIds, responsePayload } = await invokeSessionsPatch({
    key: "global",
    agentId: "work",
    label: "Work global",
  });

  expectFields(responsePayload, { ok: true, key: "global" });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "global",
    agentId: "work",
    reason: "patch",
    label: "Work global",
  });
  const mainEntry = loadSessionEntry({
    agentId: "main",
    sessionKey: "global",
    storePath: globalStores.mainStorePath,
  });
  const workEntry = loadSessionEntry({
    agentId: "work",
    sessionKey: "global",
    storePath: globalStores.workStorePath,
  });
  expect(mainEntry?.label).toBeUndefined();
  expect(workEntry?.label).toBe("Work global");
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact scopes selected global truncation to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { broadcastToConnIds, responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      agentId: "work",
      maxLines: 2,
    },
  });

  expectFields(responsePayload, { ok: true, key: "global", compacted: true, kept: 2 });
  expectChangedBroadcast(broadcastToConnIds, {
    sessionKey: "global",
    agentId: "work",
    reason: "compact",
    compacted: true,
  });
  await expect(
    loadSeededTranscriptEvents({
      agentId: "main",
      sessionId: "sess-main-global",
      sessionKey: "global",
      storePath: globalStores.mainStorePath,
    }).then(transcriptMessageContents),
  ).resolves.toEqual(["main one", "main two"]);
  await expect(
    loadSeededTranscriptEvents({
      agentId: "work",
      sessionId: "sess-work-global",
      sessionKey: "global",
      storePath: globalStores.workStorePath,
    }).then(transcriptMessageContents),
  ).resolves.toEqual(["work two"]);
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact passes the selected global agent into embedded compaction", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { responsePayload } = await invokeSessionsCompact({
    getRuntimeConfig: globalStores.getRuntimeConfig,
    params: {
      key: "global",
      agentId: "work",
    },
    subscribedConnIds: new Set(),
  });

  expectFields(responsePayload, { ok: true, key: "global", compacted: true });
  expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
  expect(embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0]).toMatchObject({
    sessionId: "sess-work-global",
    sessionKey: "global",
    agentId: "work",
    authProfileId: "github-copilot:work",
    authProfileIdSource: "user",
  });
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});
