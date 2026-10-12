import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import type { ConversationIdentity } from "../config/sessions/conversation-identity.js";
import {
  listConversations,
  prepareConversationRegistryScope,
  readConversation,
  resolveCurrentSessionPrimaryConversation,
} from "../config/sessions/conversation-registry.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  historyLane,
  targetDiscoveryLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import * as historyWorker from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runGatewayConversationList } from "./conversation-list.js";

function directoryAccountConfig(accountIds = ["default"]) {
  return {
    listAccountIds: () => accountIds,
    resolveAccount: () => ({ enabled: true, configured: true }),
    isEnabled: () => true,
    isConfigured: () => true,
  };
}

describe("runGatewayConversationList", () => {
  it("filters persisted routes before applying the result limit", async () => {
    const rows = [
      {
        conversationRef: "conv_11111111111111111111111111111111",
        channel: "reef",
        accountId: "finance",
        kind: "direct" as const,
        peerId: "finance-peer",
        target: "reef:finance-peer",
        firstSeenAt: 200,
        lastSeenAt: 200,
      },
      {
        conversationRef: "conv_22222222222222222222222222222222",
        channel: "reef",
        accountId: "personal",
        kind: "direct" as const,
        peerId: "personal-peer",
        target: "reef:personal-peer",
        firstSeenAt: 100,
        lastSeenAt: 100,
      },
    ];
    const listPersisted = vi.fn((_scope, options: { limit?: number }) =>
      options.limit === undefined ? rows : rows.slice(0, options.limit),
    );

    const result = await runGatewayConversationList(
      {
        config: {
          agents: { entries: { personal: {}, finance: {} } },
          bindings: [
            {
              type: "route",
              agentId: "personal",
              match: { channel: "reef", accountId: "personal" },
            },
            {
              type: "route",
              agentId: "finance",
              match: { channel: "reef", accountId: "finance" },
            },
          ],
        },
        agentId: "personal",
        limit: 1,
      },
      {
        listConversations: listPersisted,
        registerConversationAddresses: vi.fn(),
        resolveOutboundChannelPlugin: vi.fn(),
        resolveOutboundSessionRoute: vi.fn(),
      } as never,
    );

    expect(listPersisted).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "personal" }),
      {},
    );
    expect(result.conversations).toEqual([
      expect.objectContaining({ accountId: "personal", target: "reef:personal-peer" }),
    ]);
  });

  it("discovers a trusted directory peer without creating a session", async () => {
    let discovered: ConversationIdentity[] = [];
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "peer-id-123", name: "Friendly Lobster", handle: "@molty" },
    ]);
    const resolveOutboundSessionRoute = vi.fn(async () => ({
      sessionKey: "agent:main:reef:direct:canonical-peer",
      baseSessionKey: "agent:main:reef:direct:canonical-peer",
      peer: { kind: "direct" as const, id: "canonical-peer" },
      chatType: "direct" as const,
      from: "reef:canonical-peer",
      to: "reef:peer-id-123",
    }));
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "reef",
        config: directoryAccountConfig(),
        directory: { listPeers, listGroups: async () => [] },
      })),
      resolveOutboundSessionRoute,
      registerConversationAddresses: vi.fn(
        (_scope, identities: readonly ConversationIdentity[], _at, isEligible) => {
          const eligible = isEligible(identities);
          discovered = identities.filter((_, index) => eligible[index]);
        },
      ),
      listConversations: vi.fn(() =>
        discovered.map((identity) => ({
          conversationRef: identity.conversationRef,
          channel: identity.channel,
          accountId: identity.accountId,
          kind: identity.kind,
          peerId: identity.peerId,
          target: identity.deliveryTarget,
          label: identity.label,
          firstSeenAt: 100,
          lastSeenAt: 100,
        })),
      ),
    };

    const result = await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "reef", query: "@molty", limit: 50 },
      deps as never,
    );

    expect(listPeers).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "default", query: "@molty", limit: 50 }),
    );
    expect(deps.listConversations).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
      { channel: "reef" },
    );
    expect(resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "reef",
        agentId: "main",
        accountId: "default",
        target: "peer-id-123",
        resolvedTarget: {
          to: "peer-id-123",
          kind: "user",
          display: "Friendly Lobster",
          source: "directory",
          resolutionSource: "directory",
        },
      }),
    );
    expect(result.conversations).toEqual([
      expect.objectContaining({
        conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/u),
        channel: "reef",
        accountId: "default",
        kind: "direct",
        target: "reef:peer-id-123",
        label: "Friendly Lobster",
      }),
    ]);
    expect(result.conversations[0]).not.toHaveProperty("sessionId");
    expect(discovered).toEqual([
      expect.objectContaining({
        peerId: "canonical-peer",
        deliveryTarget: "reef:peer-id-123",
        nativeDirectUserId: "canonical-peer",
      }),
    ]);
  });

  it("keeps a discovered group origin distinct from its channel delivery address", async () => {
    let discovered: ConversationIdentity[] = [];
    const channelId = "private-room-123";
    const resolveOutboundSessionRoute = vi.fn(async () => ({
      sessionKey: `agent:main:reef:group:${channelId}`,
      baseSessionKey: `agent:main:reef:group:${channelId}`,
      peer: { kind: "group" as const, id: channelId },
      chatType: "group" as const,
      from: `reef:group:${channelId}`,
      to: `channel:${channelId}`,
    }));
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "reef",
        config: directoryAccountConfig(),
        directory: {
          listPeers: async () => [],
          listGroups: async () => [
            { kind: "group" as const, id: `channel:${channelId}`, name: "Private room" },
          ],
        },
      })),
      resolveOutboundSessionRoute,
      registerConversationAddresses: vi.fn(
        (_scope, identities: readonly ConversationIdentity[], _at, isEligible) => {
          const eligible = isEligible(identities);
          discovered = identities.filter((_, index) => eligible[index]);
        },
      ),
      listConversations: vi.fn(() => []),
    };

    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "reef", limit: 50 },
      deps as never,
    );

    expect(resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: `channel:${channelId}`,
        resolvedTarget: expect.objectContaining({
          kind: "group",
          to: `channel:${channelId}`,
        }),
      }),
    );
    expect(discovered).toEqual([
      expect.objectContaining({
        channel: "reef",
        kind: "group",
        peerId: channelId,
        deliveryTarget: `channel:${channelId}`,
        nativeChannelId: channelId,
      }),
    ]);
  });

  it("merges live directory adapters with config-backed entries", async () => {
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "stale-peer", name: "Stale Peer" },
      { kind: "user" as const, id: "shared-peer", name: "Configured Shared Peer" },
    ]);
    const listPeersLive = vi.fn(async () => [
      { kind: "user" as const, id: "live-peer", name: "Live Peer" },
      { kind: "user" as const, id: "shared-peer", name: "Live Shared Peer" },
    ]);
    const listGroups = vi.fn(async () => [
      { kind: "group" as const, id: "stale-group", name: "Stale Group" },
    ]);
    const listGroupsLive = vi.fn(async () => [
      { kind: "group" as const, id: "live-group", name: "Live Group" },
    ]);
    const resolvedTargets: string[] = [];
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "discord",
        config: directoryAccountConfig(),
        directory: { listPeers, listPeersLive, listGroups, listGroupsLive },
      })),
      resolveOutboundSessionRoute: vi.fn(async ({ target }: { target: string }) => {
        resolvedTargets.push(target);
        const direct = target.endsWith("-peer");
        return {
          sessionKey: `agent:main:discord:${direct ? "direct" : "channel"}:${target}`,
          baseSessionKey: `agent:main:discord:${direct ? "direct" : "channel"}:${target}`,
          peer: { kind: direct ? ("direct" as const) : ("channel" as const), id: target },
          chatType: direct ? ("direct" as const) : ("channel" as const),
          from: `discord:${target}`,
          to: target,
        };
      }),
      registerConversationAddresses: vi.fn(),
      listConversations: vi.fn(() => []),
    };

    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );

    expect(listPeersLive).toHaveBeenCalledOnce();
    expect(listGroupsLive).toHaveBeenCalledOnce();
    expect(listPeers).toHaveBeenCalledOnce();
    expect(listGroups).toHaveBeenCalledOnce();
    expect(resolvedTargets).toEqual([
      "stale-peer",
      "shared-peer",
      "live-peer",
      "stale-group",
      "live-group",
    ]);
    expect(deps.resolveOutboundSessionRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "shared-peer",
        resolvedTarget: expect.objectContaining({ display: "Live Shared Peer" }),
      }),
    );
  });

  it("retains configured peers when live discovery is empty or fails", async () => {
    const listPeers = vi.fn(async () => [
      { kind: "user" as const, id: "configured-peer", name: "Configured Peer" },
    ]);
    const listPeersLive = vi.fn(async ({ query }: { query?: string }) =>
      query ? [{ kind: "user" as const, id: "live-peer", name: "Live Peer" }] : [],
    );
    listPeersLive.mockRejectedValueOnce(new Error("directory unavailable"));
    const resolvedTargets: string[] = [];
    const deps = {
      resolveOutboundChannelPlugin: vi.fn(() => ({
        id: "discord",
        config: directoryAccountConfig(),
        directory: { listPeers, listPeersLive },
      })),
      resolveOutboundSessionRoute: vi.fn(async ({ target }: { target: string }) => {
        resolvedTargets.push(target);
        return {
          sessionKey: `agent:main:discord:direct:${target}`,
          baseSessionKey: `agent:main:discord:direct:${target}`,
          peer: { kind: "direct" as const, id: target },
          chatType: "direct" as const,
          from: `discord:${target}`,
          to: target,
        };
      }),
      registerConversationAddresses: vi.fn(),
      listConversations: vi.fn(() => []),
    };

    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );
    await runGatewayConversationList(
      { config: {}, agentId: "main", channel: "discord", limit: 50 },
      deps as never,
    );

    expect(listPeers).toHaveBeenCalledTimes(2);
    expect(listPeersLive).toHaveBeenCalledTimes(2);
    expect(listPeersLive.mock.calls.map(([input]) => input)).toEqual([
      expect.not.objectContaining({ query: expect.anything() }),
      expect.not.objectContaining({ query: expect.anything() }),
    ]);
    expect(resolvedTargets).toEqual(["configured-peer", "configured-peer"]);
  });
});

describe("worker conversation reads", () => {
  let state: OpenClawTestState;
  let storePath: string;
  const sessionKey = "agent:main:reef:channel:room";
  const sessionId = "conversation-read-session";
  const config = (): OpenClawConfig => ({
    agents: {
      defaults: { sessionStore: { agentId: "main" } },
      entries: { main: {}, other: {} },
    },
    bindings: [{ type: "route", agentId: "main", match: { channel: "reef" } }],
    session: { store: storePath },
  });
  const scope = () => ({ agentId: "main", storePath, sessionKey, sessionId });

  beforeAll(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    storePath = state.statePath("shared-conversations.sqlite");
    openOpenClawAgentDatabase({ agentId: "physical-owner", path: storePath });
    replaceSessionEntrySync(scope(), {
      sessionId,
      updatedAt: 100,
      chatType: "channel",
      delivery: {
        kind: "external",
        route: {
          channel: "reef",
          accountId: "default",
          target: { to: "reef:room", chatType: "channel" },
        },
        context: { channel: "reef", accountId: "default", to: "reef:room" },
        origin: { provider: "reef", accountId: "default" },
      },
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => state.cleanup());

  it("reads a shared store's list, exact address and primary binding without caller-thread SQLite", async () => {
    const observer = observeParentSqlite();
    try {
      const result = await runGatewayConversationList({
        config: config(),
        agentId: "main",
        limit: 10,
      });
      expect(result.conversations).toEqual([
        expect.objectContaining({ channel: "reef", target: "reef:room" }),
      ]);
      const ref = result.conversations[0]!.conversationRef;
      const exact = await readConversation(scope(), ref);
      expect(exact).toMatchObject({ conversationRef: ref, sessionId, sessionKey, role: "primary" });
      expect(await resolveCurrentSessionPrimaryConversation(scope())).toEqual(exact);
      const missing = state.statePath("absent", "openclaw-agent.sqlite");
      expect(await listConversations({ agentId: "main", storePath: missing })).toEqual([]);
      expect(observer.counts).toEqual(emptySqliteCounts());
      await expect(fs.stat(missing)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      observer.restore();
    }
  });

  it("rechecks current route ownership after the worker reply is delayed", async () => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const readDatabase = historyWorker.withSessionHistoryWorkerDatabase;
    vi.spyOn(historyWorker, "withSessionHistoryWorkerDatabase").mockImplementation(
      (database, consume, lane) =>
        readDatabase(
          database,
          (owner) =>
            consume({
              ...owner,
              async readConversations(...args) {
                const rows = await owner.readConversations(...args);
                entered.resolve();
                await release.promise;
                return rows;
              },
            }),
          lane,
        ),
    );
    let current = config();
    const pending = runGatewayConversationList({
      config: current,
      readCurrentConfig: () => current,
      agentId: "main",
      limit: 10,
    });
    const outcome = pending.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        pending,
        "Conversation read was not dispatched",
      );
      current = {
        ...current,
        bindings: [{ type: "route", agentId: "other", match: { channel: "reef" } }],
      };
      release.resolve();
      await expect(pending).resolves.toEqual({ conversations: [] });
    } finally {
      release.resolve();
      await outcome;
    }
  });

  it.each(["conversation-rows", "session-store-target"] as const)(
    "refuses a replaced source while %s is pending",
    async (phase) => {
      const directory = state.statePath(phase);
      const missing = state.statePath(phase, "openclaw-agent.sqlite");
      const locator =
        phase === "session-store-target" ? state.statePath(phase, "sessions.json") : missing;
      await fs.mkdir(directory, { recursive: true });
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const lane = targetDiscoveryLane;
      const run = lane.pool.run.bind(lane.pool);
      vi.spyOn(lane.pool, "run").mockImplementation(async (...args) => {
        const reply = await run(...args);
        if (
          reply.ok &&
          typeof reply.value === "object" &&
          !Array.isArray(reply.value) &&
          "kind" in reply.value &&
          reply.value.kind === phase
        ) {
          entered.resolve();
          await release.promise;
        }
        return reply;
      });
      const pending = listConversations({ agentId: "main", storePath: locator });
      const outcome = pending.catch((error: unknown) => error);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "Conversation read was not dispatched",
        );
        await fs.writeFile(missing, "replacement source");
        release.resolve();
        await expect(pending).rejects.toThrow(/Session store changed/);
      } finally {
        release.resolve();
        await outcome;
        await fs.unlink(missing).catch(() => {});
      }
    },
  );

  it("keeps process-held incognito conversations with their memory owner", async () => {
    const memory = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      sessionKey: "agent:main:dashboard:incognito-conversation-read",
      sessionId: "incognito-conversation-read",
    };
    await replaceSessionEntry(memory, {
      sessionId: memory.sessionId,
      updatedAt: 100,
      chatType: "channel",
      delivery: {
        kind: "external",
        route: {
          channel: "reef",
          accountId: "default",
          target: { to: "reef:room", chatType: "channel" },
        },
        context: { channel: "reef", accountId: "default", to: "reef:room" },
        origin: { provider: "reef", accountId: "default" },
      },
    });
    const worker = vi.spyOn(historyLane.pool, "run");
    const prepared = await prepareConversationRegistryScope({
      agentId: "main",
      config: { session: { store: memory.storePath } },
    });
    const rows = await listConversations(prepared);
    expect(rows).toEqual([
      expect.objectContaining({ sessionId: memory.sessionId, sessionKey: memory.sessionKey }),
    ]);
    expect(await resolveCurrentSessionPrimaryConversation(memory)).toEqual(rows[0]);
    expect(worker).not.toHaveBeenCalled();
    await expect(fs.stat(memory.storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
