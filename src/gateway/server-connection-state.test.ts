import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listSystemPresence, upsertPresence } from "../infra/system-presence.js";
import { requestRpcSourceCancellation } from "../sessions/session-controller.rpc-sources.js";
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { makeClient as makeBroadcastClient } from "./server-broadcast.test-helpers.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { systemHandlers } from "./server-methods/system.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { gatewayProfile } from "./server/client-fixtures.test-support.js";
import { buildGatewaySnapshot } from "./server/health-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { prepareSessionEventProjection } from "./session-event-projection.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import type { GatewaySessionRow } from "./session-utils.types.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";

type ConnectionIdReads = { count: number };

function humanEntry(
  sessionId: string,
  visibility: "suggest" | "draft" | "shared",
  id: string,
  updatedAt = 1,
) {
  return {
    sessionId,
    updatedAt,
    visibility,
    createdActor: { type: "human" as const, source: "profile" as const, id },
  };
}

function makeState(
  bootId: string,
  cfg: OpenClawConfig = {},
  getRuntimeConfig?: () => OpenClawConfig,
) {
  const state = createGatewayConnectionState({
    scheduler: createTestGatewayScheduler(),
    bootId,
    cfg,
    getRuntimeConfig,
  });
  return Object.assign(state, { [Symbol.asyncDispose]: () => state.mentionInbox.dispose() });
}

type Peer = ReturnType<typeof makeClient>;
type State = ReturnType<typeof makeState>;

async function project(options: Parameters<typeof createSessionRowProjection>[0], state?: State) {
  const projection = await createSessionRowProjection(options);
  const detach = state?.attachSessionRowProjection(projection);
  return Object.assign(projection, {
    [Symbol.dispose]() {
      detach?.();
      projection.dispose();
    },
  });
}

function payload(
  peer: Peer,
  index = peer.send.mock.calls.length - 1,
): { session: GatewaySessionRow } {
  return JSON.parse(String(peer.send.mock.calls[index]?.[0])).payload;
}

function expectSent(peers: Peer[], count: number) {
  for (const peer of peers) {
    expect(peer.send).toHaveBeenCalledTimes(count);
  }
}

const sessionScope = (sessionKey: string) => ({ sessionKeys: [sessionKey], agentId: "main" });

function broadcastChanged(
  state: State,
  sessionKey: string,
  options: Parameters<State["broadcast"]>[2] = {},
) {
  state.broadcast(
    "sessions.changed",
    { sessionKey, agentId: "main", reason: "metadata" },
    { ...sessionScope(sessionKey), ...options },
  );
}

function identify(
  client: GatewayWsClient,
  profileId: string,
  displayName: string | null = null,
  updatedAt = 1,
) {
  client.authenticatedUserProfile = {
    ...gatewayProfile(profileId, displayName, updatedAt),
    avatarRevision: "test",
  };
}

function controlUi(client: GatewayWsClient) {
  client.connect.client = {
    id: "openclaw-control-ui",
    version: "test",
    platform: "web",
    mode: "webchat",
  };
}

function withoutSql(run: () => void) {
  const sql = observeHostDataSql();
  try {
    run();
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
}

function makeClient(connId: string, reads: ConnectionIdReads = { count: 0 }, sendOrder?: string[]) {
  const peer = makeBroadcastClient(connId, "operator", ["operator.read"]);
  const send: ReturnType<typeof vi.fn> = vi.fn(() => sendOrder?.push(connId));
  peer.socket.send = send;
  Object.defineProperty(peer.client, "connId", {
    configurable: true,
    enumerable: true,
    get() {
      reads.count += 1;
      return connId;
    },
  });
  return { ...peer, send };
}

describe("gateway connection state", () => {
  it("retires tool recipients across reconnects without retiring their active runs", () => {
    const state = makeState("tool-recipient-retirement");
    onTestFinished(() => state.mentionInbox.dispose());
    const context = createGatewayRequestContext(makeContextParams(state));
    const live = makeClient("live").client;
    state.clients.add(live);
    state.chatRunState.getOrCreate("active").buffer = "unfinished response";
    context.registerToolEventRecipient("active", live.connId);

    for (let cycle = 0; cycle < 20; cycle++) {
      const client = makeClient(`reconnect-${cycle}`).client;
      const connection = new AbortController();
      client.connectionSignal = connection.signal;
      state.clients.add(client);
      context.registerToolEventRecipient("active", client.connId);
      context.registerToolEventRecipient("recipient-only", client.connId);
      expect(state.toolEventRecipients.get("active")?.has(client.connId)).toBe(true);

      connection.abort();
      if (cycle % 2 === 0) {
        state.clients.delete(client);
      }
      context.unsubscribeAllSessionEvents(client.connId);
      expect(state.toolEventRecipients.get("active")).toEqual(new Set([live.connId]));
      expect(state.chatRunState.runs.has("recipient-only")).toBe(false);

      // Accepted turns can start after the requesting transport has disconnected.
      context.registerToolEventRecipient("active", client.connId);
      context.registerToolEventRecipient("late-start", client.connId);
      expect(state.toolEventRecipients.get("active")).toEqual(new Set([live.connId]));
      expect(state.chatRunState.runs.has("late-start")).toBe(false);
      state.clients.delete(client);
    }

    state.clients.delete(live);
    context.unsubscribeAllSessionEvents(live.connId);
    expect(state.toolEventRecipients.get("active")).toBeUndefined();
    expect(state.chatRunState.runs.get("active")?.buffer).toBe("unfinished response");
    state.chatRunState.clearRun("active");
    expect(state.chatRunState.runs.size).toBe(0);
  });

  it("shares active-run snapshots within a publication and refreshes after Stop", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = {};
      setRuntimeConfigSnapshot(cfg);
      const scope = {
        agentId: "main",
        sessionKey: "agent:main:publication",
        sessionId: "publication-session",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = createRpcSourceForTest({}, { ...scope, storeScope: scope.storePath });
      const release = await claimRpcSourceForTest(source);
      rpcSourceTesting.set("publication-run", source);
      await using state = makeState("active-publication", cfg);
      using projection = await project({ cfg, modelCatalog: [] }, state);
      await projection.ensureMaterialized();
      const first = makeClient("publication-first");
      const second = makeClient("publication-second");
      for (const peer of [first, second]) {
        peer.client.connect.scopes = ["operator.admin"];
        controlUi(peer.client);
        state.clients.add(peer.client);
      }
      first.send.mockImplementationOnce(() => {
        requestRpcSourceCancellation(source);
      });
      for (const hasActiveRun of [true, false]) {
        state.broadcast(
          "sessions.changed",
          { sessionKey: scope.sessionKey, reason: "metadata" },
          sessionScope(scope.sessionKey),
        );
        expect([first, second].map((peer) => payload(peer).session.hasActiveRun)).toEqual([
          hasActiveRun,
          hasActiveRun,
        ]);
      }
      release();
    });
  });

  it("uses committed policy for projected and plain session events through tentative activation", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const reader = ensureProfileForEmail("event-policy-reader@example.test");
      const other = ensureProfileForEmail("event-policy-other@example.test");
      const config = (others: "none" | "view"): OpenClawConfig => ({
        agents: { entries: { main: {} } },
        gateway: {
          roles: {
            default: "reader",
            definitions: {
              reader: {
                sessions: { others },
                agents: ["main"],
                scopes: ["operator.sessions.read"],
              },
            },
          },
        },
      });
      const restricted = config("none");
      const relaxed = config("view");
      let runtimeConfig = restricted;
      let committedConfig = restricted;
      setRuntimeConfigSnapshot(runtimeConfig);
      const ownKey = "agent:main:policy-own";
      const foreignKey = "agent:main:policy-foreign";
      for (const [sessionKey, profileId] of [
        [ownKey, reader.id],
        [foreignKey, other.id],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          humanEntry(sessionKey, "shared", profileId),
        );
      }
      await using state = makeState("committed-event-policy", restricted, () => runtimeConfig);
      using projection = await project(
        {
          cfg: runtimeConfig,
          getConfig: () => runtimeConfig,
          getPolicyConfig: () => committedConfig,
        },
        state,
      );
      const peer = makeClient("policy-reader");
      peer.client.connect.scopes = ["operator.sessions.read"];
      controlUi(peer.client);
      identify(peer.client, reader.id, "Reader", reader.updatedAt);
      prepareGatewayRecipientProfile(peer.client);
      state.clients.add(peer.client);
      const publish = (stage: string, visibleKeys: string[]) => {
        peer.send.mockClear();
        for (const sessionKey of [ownKey, foreignKey]) {
          const scope = sessionScope(sessionKey);
          state.broadcast("sessions.changed", { sessionKey, reason: "metadata" }, scope);
          state.broadcast(
            "chat",
            {
              sessionKey,
              runId: "policy-run",
              seq: 1,
              state: "delta",
              message: { role: "assistant", content: [{ type: "text", text: sessionKey }] },
            },
            scope,
          );
        }
        const frames = peer.send.mock.calls.map(([frame]) => {
          const { event, payload: data } = JSON.parse(String(frame));
          return [event, data.sessionKey, event === "chat" ? data.message : data.session?.key];
        });
        expect.soft(frames, stage).toEqual(
          visibleKeys.flatMap((key) => [
            ["sessions.changed", key, key],
            ["chat", key, { role: "assistant", content: [{ type: "text", text: key }] }],
          ]),
        );
      };
      await projection.ensureMaterialized();
      publish("serving policy", [ownKey]);
      for (const [stage, cfg] of [
        ["tentative relaxation", relaxed],
        ["rollback", restricted],
      ] as const) {
        runtimeConfig = cfg;
        setRuntimeConfigSnapshot(runtimeConfig);
        await projection.ensureMaterialized();
        publish(stage, [ownKey]);
      }
      runtimeConfig = relaxed;
      setRuntimeConfigSnapshot(runtimeConfig);
      await projection.ensureMaterialized();
      committedConfig = relaxed;
      publish("committed relaxation without a projection mark", [ownKey, foreignKey]);

      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: ownKey },
        { parentSessionKey: foreignKey },
      );
      const later = makeClient("later-policy-reader");
      later.client.connect = { ...peer.client.connect };
      later.client.authenticatedUserProfile = peer.client.authenticatedUserProfile;
      prepareGatewayRecipientProfile(later.client);
      state.clients.add(later.client);
      peer.send.mockClear();
      peer.send.mockImplementationOnce(() => {
        committedConfig = restricted;
      });
      const publishPrepared = (beforePublish = () => {}) =>
        projection.withPreparedExactRows(
          () => [{ key: ownKey, agentId: "main" }],
          (read) => {
            beforePublish();
            broadcastChanged(state, ownKey, {
              prepareSessionProjection: prepareSessionEventProjection(projection, read),
            });
          },
          { includeAncestors: true },
        );
      await publishPrepared();
      expectSent([peer, later], 1);
      expect(payload(peer)).toMatchObject({
        session: { key: ownKey },
        ancestorSessions: [{ key: foreignKey }],
      });
      expect(payload(later)).toMatchObject({
        session: { key: ownKey },
        ancestorSessions: [],
      });
      expect(payload(later)).not.toHaveProperty("ancestorSessionRefs");
      using replacement = await project({
        cfg: runtimeConfig,
        getPolicyConfig: () => committedConfig,
      });
      let detachReplacement: (() => void) | undefined;
      try {
        await replacement.ensureMaterialized();
        peer.send.mockClear();
        later.send.mockClear();
        await publishPrepared(() => {
          detachReplacement = state.attachSessionRowProjection(replacement);
        });
        expectSent([peer, later], 0);
        broadcastChanged(state, ownKey);
        expectSent([peer, later], 1);
      } finally {
        detachReplacement?.();
      }
    });
  });

  it("advertises online people only through live operator connections", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const reads = { count: 0 };
      const requester = makeClient("requester", reads);
      const recipient = makeClient("recipient", reads);
      for (const [name, peer] of [
        ["requester", requester],
        ["recipient", recipient],
      ] as const) {
        controlUi(peer.client);
        identify(peer.client, ensureProfileForEmail(`${name}@example.test`).id, name);
      }
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      await using state = makeState("online-recipients", { agents: { entries: { main: {} } } });
      for (const peer of [requester, recipient]) {
        prepareGatewayRecipientProfile(peer.client);
        state.clients.add(peer.client);
      }
      const recipientOnline = async () => {
        let online: boolean | undefined;
        await state.mentionInbox.mentionable(
          requester.client,
          { agentId: "main", visibility: "shared" },
          (result) => {
            if (!result.ok) {
              throw new Error(result.error.message);
            }
            online = result.value.users.find(
              (user) => user.profileId === recipient.client.authenticatedUserProfile?.profileId,
            )?.online;
          },
        );
        return online;
      };

      expect(await recipientOnline()).toBe(true);
      recipient.socket.readyState = WebSocket.CLOSING;
      expect(await recipientOnline()).toBe(false);
      recipient.socket.readyState = WebSocket.OPEN;
      recipient.client.connect.role = "node";
      expect(await recipientOnline()).toBe(false);
      recipient.client.connect.role = "operator";
      recipient.client.invalidated = true;
      expect(await recipientOnline()).toBe(false);
    });
  });

  it("broadcasts to 50 members from committed facts while rows are dirty and revokes immediately without SQL", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg: OpenClawConfig = {};
      setRuntimeConfigSnapshot(cfg);
      const scope = { agentId: "main", sessionKey: "agent:main:broadcast-members" };
      await upsertSessionEntryCore(scope, humanEntry("broadcast-members", "suggest", "owner"));
      addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 1 });
      let broadcastDuringPublication: (() => void) | undefined;
      const stopPublication = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          broadcastDuringPublication?.();
        }
      });
      await using state = makeState("members", cfg);
      using projection = await project({ cfg, modelCatalog: [] }, state);
      const peers = Array.from({ length: 50 }, (_, index) => {
        const peer = makeClient(`viewer-${index}`);
        identify(peer.client, "member");
        peer.client.preparedSessionProfile = {
          profileId: "member",
          aliases: new Set(["member"]),
          role: null,
        };
        state.clients.add(peer.client);
        return peer;
      });
      const targets = new Set(peers.map((peer) => peer.client.connId));
      const broadcast = () =>
        state.broadcastToConnIds(
          "session.suggestion",
          {
            sessionKey: scope.sessionKey,
            agentId: "main",
            suggestion: { author: { id: "author" } },
          },
          targets,
        );
      const expectDeliveryWithoutSql = (count: number) =>
        withoutSql(() => {
          broadcast();
          expectSent(peers, count);
        });
      try {
        await projection.ensureMaterialized();
        sessionChanges.emit(scope);
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        expectDeliveryWithoutSql(1);
        removeSessionMember(scope, "member");
        expectDeliveryWithoutSql(1);
        addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 2 });
        broadcast();
        expectSent(peers, 2);
        const replace = (visibility: "suggest" | "draft" | "shared", updatedAt: number) =>
          replaceSessionEntrySync(
            scope,
            humanEntry("broadcast-replacement", visibility, "owner", updatedAt),
          );
        replace("suggest", 2);
        expectDeliveryWithoutSql(2);
        await projection.ensureMaterialized();
        const publicationDirtyRows: number[] = [];
        broadcastDuringPublication = () =>
          withoutSql(() => {
            publicationDirtyRows.push(projection.dirtyRowCount);
            state.broadcastToConnIds(
              "task",
              { action: "upserted", task: { id: "task" } },
              targets,
              sessionScope(scope.sessionKey),
            );
          });
        for (const [visibility, deliveries] of [
          ["draft", 2],
          ["shared", 3],
          ["draft", 3],
        ] as const) {
          replace(visibility, 3);
          expectSent(peers, deliveries);
        }
        expect(publicationDirtyRows).toHaveLength(3);
        expect(publicationDirtyRows.every((count) => count > 0)).toBe(true);
      } finally {
        stopPublication();
      }
    });
  });

  it("serves current presence through broadcasts, RPCs, and hello without SQL while display rows are dirty", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const reader = ensureProfileForEmail("presence-reader@example.test");
      const sharedKey = "agent:main:presence-shared";
      const incognitoKey = "agent:main:dashboard:incognito-presence";
      for (const sessionKey of [sharedKey, incognitoKey, "global"]) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            ...humanEntry(sessionKey, "shared", "other-owner"),
            ...(sessionKey === incognitoKey ? { incognito: true } : {}),
          },
        );
      }
      await using state = makeState("presence-boundaries", cfg);
      using projection = await project({ cfg, modelCatalog: [] }, state);
      const peers = ["reader", "admin", "trailing-reader"].map((name) => {
        const peer = makeClient(`presence-${name}`);
        peer.client.connect.scopes = [name === "admin" ? "operator.admin" : "operator.read"];
        identify(peer.client, reader.id, null, reader.updatedAt);
        prepareGatewayRecipientProfile(peer.client);
        state.clients.add(peer.client);
        return peer;
      });
      const context = createGatewayRequestContext(makeContextParams(state));
      const presenceKey = "presence-boundary-watcher";
      upsertPresence(presenceKey, {
        text: presenceKey,
        watchedSessions: [sharedKey, incognitoKey, "agent:main:global"],
      });
      try {
        await projection.ensureMaterialized();
        const scope = { agentId: "main", sessionKey: sharedKey };
        sessionChanges.emit(scope);
        const verify = (sharedVisible: boolean) => {
          expect(projection.dirtyRowCount).toBeGreaterThan(0);
          withoutSql(() => {
            peers.forEach(({ send }) => send.mockClear());
            state.broadcast("presence", { presence: listSystemPresence() });
            for (const [index, peer] of peers.entries()) {
              const watchedSessions =
                index === 1
                  ? [sharedKey, incognitoKey, "agent:main:global"]
                  : [...(sharedVisible ? [sharedKey] : []), "agent:main:global"];
              const expected = expect.arrayContaining([
                expect.objectContaining({ text: presenceKey, watchedSessions }),
              ]);
              expect(peer.send).toHaveBeenCalledOnce();
              const frame = peer.send.mock.calls[0]?.[0];
              expect(JSON.parse(String(frame))).toMatchObject({
                event: "presence",
                payload: { presence: expected },
              });
              const respond = vi.fn();
              void systemHandlers["system-presence"]!({
                req: { type: "req", id: "presence", method: "system-presence" },
                params: {},
                client: peer.client,
                respond,
                context,
                isWebchatConnect: () => true,
              });
              expect(respond).toHaveBeenCalledExactlyOnceWith(true, expected, undefined);
              expect(
                buildGatewaySnapshot({
                  client: peer.client,
                  sessionRowProjection: projection,
                  revisionProjector: context.configRevisionProjector,
                }).presence,
              ).toEqual(expected);
            }
          });
        };
        verify(true);
        replaceSessionEntrySync(scope, humanEntry(sharedKey, "draft", "other-owner", 2));
        verify(false);
        const replace = (visibility: "shared" | "draft", updatedAt: number) =>
          replaceSessionEntrySync(scope, { sessionId: sharedKey, updatedAt, visibility });
        replace("shared", 3);
        peers[0]!.send.mockImplementationOnce(() => {
          replace("draft", 4);
        });
        state.broadcast("presence", { presence: listSystemPresence() });
        const trailing = JSON.parse(String(peers[2]!.send.mock.lastCall?.[0]));
        expect(trailing.payload.presence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              text: presenceKey,
              watchedSessions: ["agent:main:global"],
            }),
          ]),
        );
      } finally {
        upsertPresence(presenceKey, { watchedSessions: undefined });
      }
    });
  });

  it("bounds ordered targeted delivery and connection lookups to requested connections", () => {
    const state = makeState("targeted-delivery");
    onTestFinished(() => state.mentionInbox.dispose());
    const reads = { count: 0 };
    const sendOrder: string[] = [];
    state.clients.add(makeClient("first", reads, sendOrder).client);
    for (let index = 0; index < 256; index += 1) {
      state.clients.add(makeClient(`other-${index}`, reads).client);
    }
    const target = makeClient("target", reads, sendOrder);
    state.clients.add(target.client);
    reads.count = 0;
    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["target", "first"]));
    expect(sendOrder).toEqual(["first", "target"]);
    expect(target.send).toHaveBeenCalledTimes(1);
    expect([state.getBufferedAmount("target"), reads.count]).toEqual([0, 0]);

    target.socket.readyState = WebSocket.CLOSING;
    state.broadcastToConnIds("tick", { ts: 2 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);

    reads.count = 0;
    const expectConnection = (active: boolean) =>
      expect([
        state.getBufferedAmount("target"),
        state.isConnectionActive("target"),
        reads.count,
      ]).toEqual([undefined, active, 0]);
    expectConnection(true);

    const firstRequest = state.clients.retainRequest(target.client);
    const secondRequest = state.clients.retainRequest(target.client);
    state.clients.delete(target.client);
    expect(
      [...state.clients.authorityClients].filter((client) => client === target.client),
    ).toHaveLength(1);
    firstRequest();
    firstRequest();
    expect([...state.clients.authorityClients]).toContain(target.client);
    reads.count = 0;
    state.broadcastToConnIds("tick", { ts: 3 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);
    expectConnection(false);

    secondRequest();
    expect([...state.clients.authorityClients]).not.toContain(target.client);
    state.clients.add(target.client);
    state.clients.clear();
    reads.count = 0;

    expectConnection(false);
  });
});
