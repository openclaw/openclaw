import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { subscribePluginSessionsChanged } from "../plugins/services.test-support.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import { bindInProcessRequestMutationAuthority } from "./server-methods/session-mutation-guards.js";
import { initializeSessionReadContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewayModelCatalogSnapshot } from "./server-model-catalog.types.js";
import {
  registerSessionListRpcSourceForTest,
  setupPersistentSessionListTestHarness,
} from "./server.sessions.list-changed.fixture.test-support.js";
import {
  requireRecord,
  expectFields,
  transcriptMessageContents,
  expectRespondPayload,
  expectChangedBroadcast,
} from "./server.sessions.list-changed.test-helpers.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { seedCompletedSessionTranscript } from "./session-row-fixtures.test-support.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { embeddedRunMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  getGatewayConfigModule,
  getSessionsHandlers,
  loadSeededTranscriptEvents,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const {
  createConfiguredGlobalAgentSessionStore,
  createSessionStoreDir,
  createFreshSessionStoreDir,
  openClient,
  resetConfiguredGlobalAgentSessionStore,
} = setupPersistentSessionListTestHarness();

type MutationMethod = "sessions.patch" | "sessions.compact";
type SeedMessage = Parameters<typeof seedCompletedSessionTranscript>[0]["message"];

function reply(
  provider: string,
  model: string,
  [input, output, cacheRead, cacheWrite]: [number, number, number, number?],
  cost?: number,
): SeedMessage {
  const usage: SeedMessage["usage"] = { input, output, cacheRead };
  if (cacheWrite !== undefined) {
    usage.cacheWrite = cacheWrite;
  }
  if (cost !== undefined) {
    usage.cost = { total: cost };
  }
  return { role: "assistant", provider, model, usage };
}

async function invokeSessionMutation(
  params: Record<string, unknown>,
  context: Record<string, unknown> = {},
  subscribedConnIds = new Set(["conn-1"]),
  method: MutationMethod = "sessions.patch",
) {
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const requestContext = {
    getRuntimeConfig,
    broadcastToConnIds,
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => subscribedConnIds,
    loadGatewayModelCatalog: async () => ({ providers: [] }),
    loadGatewayModelCatalogSnapshot: () => mutationCatalogSnapshot([]),
    ...context,
  } as unknown as GatewayRequestContext;
  const handler = expectDefined(sessionsHandlers[method], "session handler");
  await initializeSessionReadContext(requestContext);
  const options = {
    req: { type: "req" as const, id: "test-request", method, params },
    params,
    respond,
    client: null,
    isWebchatConnect: () => false,
    context: requestContext,
  };
  await handler(bindInProcessRequestMutationAuthority(options, undefined, undefined));
  await flushPendingSessionsChangedEvents(requestContext);
  return { responsePayload: expectRespondPayload(respond), broadcastToConnIds };
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

async function expectManagementPatch(
  params: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  const result = await invokeSessionMutation({ key: "discord:group:dev", ...params });
  return expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:discord:group:dev",
    reason: "patch",
    ...expected,
  });
}

async function writeMainSessionStore(options?: Parameters<typeof sessionStoreEntry>[1]) {
  await createSessionStoreDir();
  await writeSessionStore({ entries: { main: sessionStoreEntry("sess-main", options) } });
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
    message: reply("anthropic", "claude-sonnet-4-6", [2_000, 500, 1_000], 0.0042),
    trailingMessages: [reply("openclaw", "delivery-mirror", [0, 0, 0, 0])],
  });
  const { ws } = await openClient();
  const listed = await rpcReq<SessionsListResult>(ws, "sessions.list", {});
  expect(listed.ok).toBe(true);
  const parent = listed.payload?.sessions.find((session) => session.key === "agent:main:main");
  const child = listed.payload?.sessions.find(
    (session) => session.key === "agent:main:dashboard:child",
  );
  expect(parent?.childSessions).toEqual(["agent:main:dashboard:child"]);
  expect(child).toMatchObject({
    parentSessionKey: "agent:main:main",
    totalTokens: 3_000,
    totalTokensFresh: true,
    estimatedCostUsd: 0.0042,
    modelProvider: "anthropic",
    model: "test-model-without-catalog-context",
    modelSelectionLocked: true,
  });
  expect(child?.contextTokens).toBeUndefined();

  const gallery = await rpcReq<SessionsListResult>(ws, "sessions.list", {
    rowMode: "dashboard",
  });
  expect(gallery.ok).toBe(true);
  const galleryChild = gallery.payload?.sessions.find((row) => row.key === child?.key);
  expect(galleryChild).toMatchObject({
    rowMode: "dashboard",
    parentSessionKey: "agent:main:main",
    sessionId: "sess-child",
  });
  expect(galleryChild).not.toHaveProperty("totalTokens");
  expect(galleryChild).not.toHaveProperty("model");
  ws.close();
});

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
  const result = await invokeSessionMutation(
    { key: "main", label: "Renamed" },
    { loadGatewayModelCatalogSnapshot },
  );
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
    await invokeSessionMutation(
      { key: "main", label: "Renamed title" },
      { broadcastToConnIds },
      new Set(),
    );
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

test("sessions.changed does not publish a preparing source as running", async () => {
  await writeMainSessionStore({ status: "failed" });
  await registerSessionListRpcSourceForTest({ executionStarted: false });
  const result = await invokeSessionMutation({ key: "main", label: "Starting main" });
  expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    status: "failed",
    hasActiveRun: false,
    activeRunIds: [],
  });
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
      ...reply("openai", "test-unpriced-model", [5_107, 1_827, 1_536, 0], 0),
      timestamp: Date.now(),
    },
  });
  const result = await invokeSessionMutation({ key: "main", label: "Renamed" });
  expectFields(result.responsePayload, { ok: true, key: "agent:main:main" });
  expectChangedBroadcast(result.broadcastToConnIds, {
    sessionKey: "agent:main:main",
    reason: "patch",
    effectiveResponseUsage: "off",
    totalTokens: 6_643,
    totalTokensFresh: true,
    contextTokens: 123_456,
    estimatedCostUsd: undefined,
    modelProvider: "openai",
    model: "test-unpriced-model",
    responseUsage: undefined,
  });
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
  for (const archived of [true, false]) {
    await expectManagementPatch(
      { expectedSessionId: "sess-dev", archived },
      {
        archived,
        archivedAt: archived ? expect.any(Number) : null,
        ...(archived
          ? { pinned: false, pinnedAt: null, unread: false, lastReadAt: 20, lastActivityAt: 5 }
          : {}),
      },
    );
  }
  for (const pinned of [true, false]) {
    await expectManagementPatch(
      { pinned },
      { pinned, pinnedAt: pinned ? expect.any(Number) : null },
    );
  }
  const markUnread = (expected: Record<string, unknown> = {}) =>
    expectManagementPatch(
      { unread: true },
      { unread: true, markedUnreadAt: expect.any(Number), ...expected },
    );
  const markRead = (params: Record<string, unknown> = {}) =>
    expectManagementPatch(
      { unread: false, ...params },
      {
        unread: false,
        lastReadAt: expect.any(Number),
        markedUnreadAt: null,
        lastActivityAt: 5,
      },
    );
  const unreadPayload = await markUnread({ lastReadAt: 20, lastActivityAt: 5 });
  const marker = expectDefined(
    unreadPayload.markedUnreadAt as number | undefined,
    "manual unread marker",
  );
  expect(marker).toEqual(expect.any(Number));
  const staleRead = await invokeSessionMutation({
    key: "discord:group:dev",
    unread: false,
    expectedMarkedUnreadAt: null,
  });
  expectFields(staleRead.responsePayload, { ok: true, key: "agent:main:discord:group:dev" });
  expect(staleRead.broadcastToConnIds).not.toHaveBeenCalled();
  expect(requireRecord(staleRead.responsePayload.entry, "stale read entry").markedUnreadAt).toBe(
    marker,
  );
  await markRead({ expectedMarkedUnreadAt: marker });
  await markUnread();
  await markRead();
});

test("sessions.patch scopes selected global mutations and events to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ writePrimeStore: true });
  const { broadcastToConnIds, responsePayload } = await invokeSessionMutation({
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
  for (const [agentId, storePath, label] of [
    ["main", globalStores.mainStorePath, undefined],
    ["work", globalStores.workStorePath, "Work global"],
  ] as const) {
    expect(loadSessionEntry({ agentId, sessionKey: "global", storePath })?.label).toBe(label);
  }
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test.each(["transcript truncation", "embedded compaction"] as const)(
  "sessions.compact scopes selected global %s to the requested agent",
  async (mode) => {
    const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
    const truncate = mode === "transcript truncation";
    const { broadcastToConnIds, responsePayload } = await invokeSessionMutation(
      { key: "global", agentId: "work", ...(truncate ? { maxLines: 2 } : {}) },
      { getRuntimeConfig: globalStores.getRuntimeConfig },
      truncate ? undefined : new Set(),
      "sessions.compact",
    );
    expectFields(responsePayload, {
      ok: true,
      key: "global",
      compacted: true,
      ...(truncate ? { kept: 2 } : {}),
    });
    if (truncate) {
      expectChangedBroadcast(broadcastToConnIds, {
        sessionKey: "global",
        agentId: "work",
        reason: "compact",
        compacted: true,
      });
      for (const [agentId, storePath, expected] of [
        ["main", globalStores.mainStorePath, ["main one", "main two"]],
        ["work", globalStores.workStorePath, ["work two"]],
      ] as const) {
        await expect(
          loadSeededTranscriptEvents({
            agentId,
            sessionId: `sess-${agentId}-global`,
            sessionKey: "global",
            storePath,
          }).then(transcriptMessageContents),
        ).resolves.toEqual(expected);
      }
    } else {
      expect(embeddedRunMock.compactEmbeddedAgentSession).toHaveBeenCalledTimes(1);
      expect(embeddedRunMock.compactEmbeddedAgentSession.mock.calls[0]?.[0]).toMatchObject({
        sessionId: "sess-work-global",
        sessionKey: "global",
        agentId: "work",
        authProfileId: "github-copilot:work",
        authProfileIdSource: "user",
      });
    }
    await resetConfiguredGlobalAgentSessionStore(globalStores);
  },
);
