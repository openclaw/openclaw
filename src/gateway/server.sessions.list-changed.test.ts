import { expectDefined } from "@openclaw/normalization-core";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { AgentCommandGatewayIngressOpts } from "../agents/command/types.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { subscribePluginSessionsChanged } from "../plugins/services.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import type { SessionRowProjection } from "./session-row-projection.js";
import type { SessionsListResult } from "./session-utils.types.js";
import {
  agentCommandMock,
  embeddedRunMock,
  prepareGatewayReplyRuntimeForTest,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
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

async function invokeSession(
  method: "sessions.list" | MutationMethod,
  params: Record<string, unknown>,
  context: Record<string, unknown>,
  defer = false,
  subscribedConnIds = new Set(["conn-1"]),
) {
  const respond = vi.fn();
  const broadcastToConnIds = vi.fn();
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const requestContext = {
    getRuntimeConfig,
    ...(method === "sessions.list"
      ? {
          readPreparedGatewayModelCatalog: async () => ({ entries: [] }),
        }
      : {
          broadcastToConnIds,
          dedupe: new Map(),
          getSessionEventSubscriberConnIds: () => subscribedConnIds,
          loadGatewayModelCatalog: async () => ({ providers: [] }),
          loadGatewayModelCatalogSnapshot: () => mutationCatalogSnapshot([]),
        }),
    ...context,
  } as unknown as GatewayRequestContext;
  const handler = expectDefined(sessionsHandlers[method], "session handler");
  const request = initializeSessionReadContext(requestContext).then(() => {
    const options = {
      req: { type: "req" as const, id: "test-request", method, params },
      params,
      respond,
      client: null,
      isWebchatConnect: () => false,
      context: requestContext,
    };
    return handler(
      method === "sessions.list"
        ? options
        : bindInProcessRequestMutationAuthority(options, undefined, undefined),
    );
  });
  if (!defer) {
    await request;
  }
  return { request, respond, context: requestContext, broadcastToConnIds };
}

async function invokeSessionsList(
  params: Record<string, unknown> = {},
  context: Record<string, unknown> = {},
  defer = false,
) {
  return invokeSession("sessions.list", params, context, defer);
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

async function invokeSessionMutation(
  params: Record<string, unknown>,
  context = {},
  subscribedConnIds = new Set(["conn-1"]),
  method: MutationMethod = "sessions.patch",
) {
  const prepared = await invokeSession(method, params, context, false, subscribedConnIds);
  await flushPendingSessionsChangedEvents(prepared.context);
  return {
    broadcastToConnIds: prepared.broadcastToConnIds,
    responsePayload: expectRespondPayload(prepared.respond),
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
      "dashboard:live": sessionStoreEntry("sess-live"),
      "dashboard:idle": sessionStoreEntry("sess-idle", { updatedAt: Date.now() + 60_000 }),
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
    totalTokens: 3_500,
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
  await prepareGatewayReplyRuntimeForTest();
  const held = new Map<
    string,
    {
      entered: ReturnType<typeof createDeferred<void>>;
      release: ReturnType<typeof createDeferred<void>>;
    }
  >();
  for (const runId of ["list-live-z", "list-live-a"]) {
    held.set(runId, { entered: createDeferred(), release: createDeferred() });
  }
  agentCommandMock.mockImplementation(async (options) => {
    const command = options as AgentCommandGatewayIngressOpts;
    const turn = held.get(command.runId!);
    if (!turn) {
      throw new Error("Unexpected list boundary inference");
    }
    turn.entered.resolve();
    await turn.release.promise;
  });
  try {
    for (const [runId, sessionKey] of [
      ["list-live-z", "agent:main:main"],
      ["list-live-a", "agent:main:dashboard:live"],
    ] as const) {
      const accepted = await rpcReq(ws, "agent", {
        sessionKey,
        message: "Hold this list-visible turn",
        idempotencyKey: runId,
      });
      expect(accepted.ok).toBe(true);
      await held.get(runId)!.entered.promise;
    }
    type ActiveSessionPage = {
      count: number;
      totalCount: number;
      nextOffset: number | null;
      sessions: Array<{ key: string; hasActiveRun: boolean; activeRunIds: string[] }>;
    };
    const first = await rpcReq<ActiveSessionPage>(ws, "sessions.list", {
      activeOnly: true,
      limit: 1,
    });
    const second = await rpcReq<ActiveSessionPage>(ws, "sessions.list", {
      activeOnly: true,
      limit: 1,
      offset: 1,
    });
    expect(first.payload).toMatchObject({ count: 1, totalCount: 2, nextOffset: 1 });
    expect(second.payload).toMatchObject({ count: 1, totalCount: 2, nextOffset: null });
    const active = [...first.payload!.sessions, ...second.payload!.sessions];
    expect(active.map((session) => session.key).toSorted()).toEqual([
      "agent:main:dashboard:live",
      "agent:main:main",
    ]);
    expect(active.flatMap((session) => session.activeRunIds).toSorted()).toEqual([
      "list-live-a",
      "list-live-z",
    ]);
    expect(active.every((session) => session.hasActiveRun)).toBe(true);
    for (const method of ["sessions.fork", "sessions.rewind", "sessions.branches.switch"]) {
      const refused = await rpcReq(ws, method, {
        sessionKey: "agent:main:main",
        ...(method === "sessions.branches.switch"
          ? { leafEntryId: "not-yet-a-boundary" }
          : { entryId: "not-yet-a-boundary" }),
      });
      expect(refused.ok).toBe(false);
      expect(refused.error?.code, `${method}: ${JSON.stringify(refused.error)}`).toBe(
        "UNAVAILABLE",
      );
    }
  } finally {
    for (const turn of held.values()) {
      turn.release.resolve();
    }
    agentCommandMock.mockReset();
  }
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

test("sessions.list distinguishes proven idle from unavailable run identities", async () => {
  await writeMainSessionStore();
  const idle = await invokeSessionsList();
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
    const unavailable = await invokeSessionsList();
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

test("sessions.list yields for bulk metadata and later serves previews without repairing titles", async () => {
  const { storePath } = await createSessionStoreDir();
  const keys = await seedSessionListBackfillFixture(storePath, 11, 1);
  // Durable rows publish while the request creates its projection, before the test holds it.
  const requestProjection = createDeferredCore<SessionRowProjection>();
  const backfilled = observeSessionRowBackfill(keys, requestProjection.promise);
  const releaseForeground = retainSessionListForegroundWork();
  try {
    const params = { includeDerivedTitles: true, includeLastMessage: true, limit: 11 };
    const { request, respond, context } = await invokeSessionsList(
      params,
      { logGateway: { debug: vi.fn() } },
      true,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(respond).not.toHaveBeenCalled();
    await request;
    expectFields(findSession(expectRespondPayload(respond), "agent:main:bulk-10"), {
      lastMessagePreview: "last 10",
    });
    requestProjection.resolve(
      expectDefined(getSessionRowProjection(context), "request projection"),
    );
    releaseForeground();
    await backfilled;
    const refreshed = await invokeSessionsList(params, { ...context });
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
    totalTokens: 8_470,
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

test("sessions.compact scopes selected global truncation to the requested agent", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { broadcastToConnIds, responsePayload } = await invokeSessionMutation(
    { key: "global", agentId: "work", maxLines: 2 },
    { getRuntimeConfig: globalStores.getRuntimeConfig },
    undefined,
    "sessions.compact",
  );
  expectFields(responsePayload, { ok: true, key: "global", compacted: true, kept: 2 });
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
  await resetConfiguredGlobalAgentSessionStore(globalStores);
});

test("sessions.compact passes the selected global agent into embedded compaction", async () => {
  const globalStores = await createConfiguredGlobalAgentSessionStore({ withTranscripts: true });
  const { responsePayload } = await invokeSessionMutation(
    { key: "global", agentId: "work" },
    { getRuntimeConfig: globalStores.getRuntimeConfig },
    new Set(),
    "sessions.compact",
  );
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
