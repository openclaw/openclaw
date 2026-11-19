import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import type { UsageLike } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import { prepareSessionUsageUpdate } from "../auto-reply/reply/session-usage.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { projectSessionEntryUsageUpdate } from "../config/sessions/session-entry-usage.js";
import { subscribePluginSessionsChanged } from "../plugins/services.test-support.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { estimateAggregateUsageCostAsync, resolveModelCostConfig } from "../utils/usage-format.js";
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
import { GatewayClientRegistry } from "./server/client-registry.js";
import {
  rpcReq,
  writeSessionStore,
  agentCommandMock,
  embeddedRunMock,
  prepareGatewayReplyRuntimeForTest,
} from "./test-helpers.js";
import {
  getGatewayConfigModule,
  getSessionsHandlers,
  loadSeededTranscriptEvents,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

describe("session change events retained boundaries", () => {
  type CompletedReply = Record<string, unknown> & {
    role: "assistant";
    provider: string;
    model: string;
    usage: UsageLike;
  };

  /** Seed the same transcript and accounting commits that finish a reply. */
  async function seedCompletedSessionTranscript<T extends CompletedReply>(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
    entries: Parameters<typeof writeSessionStore>[0]["entries"];
    message: T;
    trailingMessages?: readonly Record<string, unknown>[];
  }): Promise<T> {
    const scope = {
      agentId: resolveAgentIdFromSessionKey(params.sessionKey),
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.storePath,
    };
    await writeSessionStore({
      agentId: scope.agentId,
      storePath: params.storePath,
      entries: params.entries,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [params.message, ...(params.trailingMessages ?? [])].map((message) => ({
        message,
      })),
      updateMode: "none",
    });
    const usage = normalizeUsage(params.message.usage);
    const prepared = prepareSessionUsageUpdate({
      estimatedCostUsd: await estimateAggregateUsageCostAsync({
        usage,
        prepareCost: () =>
          resolveModelCostConfig({
            provider: params.message.provider,
            model: params.message.model,
          }),
      }),
      usage,
      lastCallUsage: usage,
      providerUsed: params.message.provider,
      modelUsed: params.message.model,
      preserveRuntimeModel: true,
    });
    if (prepared) {
      await patchSessionEntryCore(scope, (entry) =>
        projectSessionEntryUsageUpdate(entry, prepared),
      );
    }
    return params.message;
  }

  /**
   * Legacy rows retain missing titles and need their first durable preview backfill. The last
   * `durable` rows keep their facts, as when another Gateway projection already backfilled them.
   */

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

  test("sessions.changed mutations reach plugin subscribers without websocket clients", async () => {
    await writeMainSessionStore({ label: "Original title" });
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: new GatewayClientRegistry(),
    });
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

  type MockCalls = {
    mock: { calls: unknown[][] };
  };

  function isObjectRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
  }

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    expect(isObjectRecord(value), `${label} should be an object`).toBe(true);
    if (!isObjectRecord(value)) {
      throw new Error(`${label} should be an object`);
    }
    return value;
  }

  function expectFields(record: Record<string, unknown>, expected: Record<string, unknown>) {
    for (const [key, value] of Object.entries(expected)) {
      expect(record[key], key).toEqual(value);
    }
  }

  function transcriptMessageContents(events: readonly unknown[]): unknown[] {
    return events
      .map((event) =>
        isObjectRecord(event) && isObjectRecord(event.message) ? event.message.content : undefined,
      )
      .filter((content) => content !== undefined);
  }

  function expectRespondPayload(respond: MockCalls): Record<string, unknown> {
    expect(respond.mock.calls).toHaveLength(1);
    const [ok, payload, error] = respond.mock.calls[0] ?? [];
    expect(ok).toBe(true);
    expect(error).toBeUndefined();
    return requireRecord(payload, "response payload");
  }

  function expectChangedBroadcast(
    broadcastToConnIds: MockCalls,
    expected: Record<string, unknown>,
  ): Record<string, unknown> {
    expect(broadcastToConnIds.mock.calls).toHaveLength(1);
    const [event, payload, connIds, options] = broadcastToConnIds.mock.calls[0] ?? [];
    expect(event).toBe("sessions.changed");
    expect(connIds).toEqual(new Set(["conn-1"]));
    const agentId = typeof expected.agentId === "string" ? expected.agentId : "main";
    expect(options).toEqual({
      agentId,
      dropIfSlow: true,
      prepareSessionProjection: expect.any(Function),
      sessionEventSubscriptionKeys:
        typeof expected.sessionKey === "string"
          ? [expected.sessionKey === "global" ? `agent:${agentId}:global` : expected.sessionKey]
          : [],
      ...(typeof expected.sessionKey === "string" ? { sessionKeys: [expected.sessionKey] } : {}),
    });
    const payloadRecord = requireRecord(payload, "broadcast payload");
    expectFields(payloadRecord, expected);
    return payloadRecord;
  }
  test("active sessions reject fork, rewind and branch switching", async () => {
    await createFreshSessionStoreDir();
    await writeSessionStore({ entries: { main: sessionStoreEntry("held-session") } });
    const { ws } = await openClient();
    await prepareGatewayReplyRuntimeForTest();
    const entered = createDeferred();
    const release = createDeferred();
    agentCommandMock.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      expect(
        (
          await rpcReq(ws, "agent", {
            sessionKey: "agent:main:main",
            message: "Hold this turn",
            idempotencyKey: "held-list-boundary",
          })
        ).ok,
      ).toBe(true);
      await entered.promise;
      for (const method of ["sessions.fork", "sessions.rewind", "sessions.branches.switch"]) {
        const refused = await rpcReq(ws, method, {
          sessionKey: "agent:main:main",
          ...(method === "sessions.branches.switch"
            ? { leafEntryId: "not-yet-a-boundary" }
            : { entryId: "not-yet-a-boundary" }),
        });
        expect(refused.ok).toBe(false);
        expect(refused.error?.code).toBe("UNAVAILABLE");
      }
    } finally {
      release.resolve();
      agentCommandMock.mockReset();
      ws.close();
    }
  });
});
