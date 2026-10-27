import fs from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import {
  emptySqliteCounts,
  observeParentSqlite,
} from "../../test/helpers/sqlite-parent-observer.js";
import type { ChannelDirectoryAdapter } from "../channels/plugins/types.adapters.js";
import type {
  ChannelDirectoryEntry,
  ChannelDirectoryEntryKind,
} from "../channels/plugins/types.core.js";
import type { ConversationIdentity } from "../config/sessions/conversation-identity.js";
import * as conversationRegistry from "../config/sessions/conversation-registry.js";
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
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import * as historyWorker from "../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as channelResolution from "../infra/outbound/channel-resolution.js";
import * as outboundSession from "../infra/outbound/outbound-session.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runGatewayConversationList } from "./conversation-list.js";

function outboundRoute(
  channel: string,
  target: string,
  kind: "direct" | "group" | "channel" = "direct",
  to = target,
) {
  const key = `agent:main:${channel}:${kind}:${target}`;
  return {
    sessionKey: key,
    baseSessionKey: key,
    peer: { kind, id: target },
    chatType: kind,
    from: `${channel}:${target}`,
    to,
  };
}

function directoryList(kind: ChannelDirectoryEntryKind, entries: Record<string, string>) {
  return vi.fn(async () => Object.entries(entries).map(([id, name]) => ({ kind, id, name })));
}

function directoryFixture(
  channel: string,
  directory: ChannelDirectoryAdapter,
  route: (input: { target: string }) => Promise<ReturnType<typeof outboundRoute>>,
  registration: "none" | "capture" | "project" = "none",
) {
  let discovered: ConversationIdentity[] = [];
  vi.spyOn(channelResolution, "resolveOutboundChannelPlugin").mockImplementation(() => ({
    ...createChannelTestPluginBase({ id: channel }),
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({ enabled: true, configured: true }),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    directory,
  }));
  const resolveRoute = vi
    .spyOn(outboundSession, "resolveOutboundSessionRoute")
    .mockImplementation(route);
  vi.spyOn(conversationRegistry, "registerConversationAddresses").mockImplementation(
    async (
      _scope: unknown,
      identities: readonly ConversationIdentity[],
      _at = 0,
      isEligible = (values: readonly ConversationIdentity[]) => values.map(() => true),
    ) => {
      if (registration === "none") {
        return;
      }
      const eligible = isEligible(identities);
      discovered = identities.filter((_, index) => eligible[index]);
    },
  );
  vi.spyOn(conversationRegistry, "listConversations").mockImplementation(async () =>
    (registration === "project" ? discovered : []).map((identity) => ({
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
  );
  return {
    resolveRoute,
    get discovered() {
      return discovered;
    },
    run: (options: Partial<Parameters<typeof runGatewayConversationList>[0]> = {}) =>
      runGatewayConversationList({ config: {}, agentId: "main", channel, limit: 50, ...options }),
  };
}

const reefDelivery = {
  kind: "external" as const,
  route: {
    channel: "reef",
    accountId: "default",
    target: { to: "reef:room", chatType: "channel" as const },
  },
  context: { channel: "reef", accountId: "default", to: "reef:room" },
  origin: { provider: "reef", accountId: "default" },
};
const conversationEntry = (sessionId: string) => ({
  sessionId,
  updatedAt: 100,
  chatType: "channel" as const,
  delivery: reefDelivery,
});

describe("runGatewayConversationList", () => {
  afterEach(() => vi.restoreAllMocks());
  it("filters persisted routes before applying the result limit", async () => {
    const rows = ["finance", "personal"].map((accountId, index) => ({
      conversationRef: `conv_${String(index + 1).repeat(32)}`,
      channel: "reef",
      accountId,
      kind: "direct" as const,
      peerId: `${accountId}-peer`,
      target: `reef:${accountId}-peer`,
      firstSeenAt: 200 - index * 100,
      lastSeenAt: 200 - index * 100,
    }));
    vi.spyOn(conversationRegistry, "listConversations").mockImplementation(
      async (_scope, options = {}) =>
        options.limit === undefined ? rows : rows.slice(0, options.limit),
    );

    const result = await runGatewayConversationList({
      config: {
        agents: { entries: { personal: {}, finance: {} } },
        bindings: ["personal", "finance"].map((agentId) => ({
          type: "route" as const,
          agentId,
          match: { channel: "reef", accountId: agentId },
        })),
      },
      agentId: "personal",
      limit: 1,
    });

    expect(result.conversations).toMatchObject([
      { accountId: "personal", target: "reef:personal-peer" },
    ]);
  });

  it.each(["direct", "group"] as const)(
    "discovers a trusted %s address preserving its native identity",
    async (kind) => {
      const direct = kind === "direct";
      const peerId = direct ? "canonical-peer" : "private-room-123";
      const target = direct ? "reef:peer-id-123" : `channel:${peerId}`;
      const sourceId = direct ? "peer-id-123" : target;
      const name = direct ? "Friendly Lobster" : "Private room";
      const query = direct ? "@molty" : undefined;
      const entryKind = direct ? "user" : "group";
      const list = vi.fn(async (): Promise<ChannelDirectoryEntry[]> => [
        { kind: entryKind, id: sourceId, name, ...(direct ? { handle: "@molty" } : {}) },
      ]);
      const fixture = directoryFixture(
        "reef",
        direct
          ? { listPeers: list, listGroups: async () => [] }
          : { listPeers: async () => [], listGroups: list },
        async () => ({
          ...outboundRoute("reef", peerId, kind, target),
          from: direct ? `reef:${peerId}` : `reef:group:${peerId}`,
        }),
        direct ? "project" : "capture",
      );
      const result = await fixture.run(direct ? { query } : {});
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ accountId: "default", limit: 50, ...(query ? { query } : {}) }),
      );
      if (direct) {
        expect(result.conversations).toMatchObject([
          {
            conversationRef: expect.stringMatching(/^conv_[a-f0-9]{32}$/u),
            channel: "reef",
            accountId: "default",
            kind,
            target,
            label: name,
          },
        ]);
        expect(result.conversations[0]).not.toHaveProperty("sessionId");
      }
      expect(fixture.discovered).toMatchObject([
        {
          channel: "reef",
          kind,
          peerId,
          deliveryTarget: target,
          ...(direct ? { nativeDirectUserId: peerId } : { nativeChannelId: peerId }),
        },
      ]);
    },
  );

  it("merges live directory adapters with config-backed entries", async () => {
    const listPeers = directoryList("user", {
      "stale-peer": "Stale Peer",
      "shared-peer": "Configured Shared Peer",
    });
    const listPeersLive = directoryList("user", {
      "live-peer": "Live Peer",
      "shared-peer": "Live Shared Peer",
    });
    const listGroups = directoryList("group", { "stale-group": "Stale Group" });
    const listGroupsLive = directoryList("group", { "live-group": "Live Group" });
    const fixture = directoryFixture(
      "discord",
      { listPeers, listPeersLive, listGroups, listGroupsLive },
      async ({ target }) =>
        outboundRoute("discord", target, target.endsWith("-peer") ? "direct" : "channel"),
    );
    await fixture.run();

    expect(fixture.resolveRoute.mock.calls.map(([input]) => input.target)).toEqual([
      "stale-peer",
      "shared-peer",
      "live-peer",
      "stale-group",
      "live-group",
    ]);
    expect(fixture.resolveRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "shared-peer",
        resolvedTarget: expect.objectContaining({ display: "Live Shared Peer" }),
      }),
    );
  });

  it("retains configured peers when live discovery is empty or fails", async () => {
    const listPeers = directoryList("user", { "configured-peer": "Configured Peer" });
    const listPeersLive = vi.fn(async ({ query }: { query?: string | null }) =>
      query ? [{ kind: "user" as const, id: "live-peer", name: "Live Peer" }] : [],
    );
    listPeersLive.mockRejectedValueOnce(new Error("directory unavailable"));
    const fixture = directoryFixture("discord", { listPeers, listPeersLive }, async ({ target }) =>
      outboundRoute("discord", target),
    );
    await fixture.run();
    await fixture.run();

    expect(listPeersLive.mock.calls.map(([input]) => input)).toEqual([
      expect.not.objectContaining({ query: expect.anything() }),
      expect.not.objectContaining({ query: expect.anything() }),
    ]);
    expect(fixture.resolveRoute.mock.calls.map(([input]) => input.target)).toEqual([
      "configured-peer",
      "configured-peer",
    ]);
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
    replaceSessionEntrySync(scope(), conversationEntry(sessionId));
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
      expect(result.conversations).toMatchObject([{ channel: "reef", target: "reef:room" }]);
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

  it("keeps process-held incognito conversations with their memory owner", async () => {
    const memory = {
      agentId: "main",
      storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env }),
      sessionKey: "agent:main:dashboard:incognito-conversation-read",
      sessionId: "incognito-conversation-read",
    };
    await replaceSessionEntry(memory, conversationEntry(memory.sessionId));
    const worker = vi.spyOn(historyLane.pool, "run");
    const prepared = await prepareConversationRegistryScope({
      agentId: "main",
      config: { session: { store: memory.storePath } },
    });
    const rows = await listConversations(prepared);
    expect(rows).toMatchObject([{ sessionId: memory.sessionId, sessionKey: memory.sessionKey }]);
    expect(await resolveCurrentSessionPrimaryConversation(memory)).toEqual(rows[0]);
    expect(worker).not.toHaveBeenCalled();
    await expect(fs.stat(memory.storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
