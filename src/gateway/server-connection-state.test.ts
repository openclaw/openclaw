import { describe, expect, it, onTestFinished, vi } from "vitest";
import { WebSocket } from "ws";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
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
import { sessionChanges } from "../sessions/session-row-changes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { systemHandlers } from "./server-methods/system.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { buildGatewaySnapshot } from "./server/health-state.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionRowProjection } from "./session-row-projection.js";

type ConnectionIdReads = { count: number };

function makeClient(
  connId: string,
  reads: ConnectionIdReads,
  sendOrder?: string[],
): {
  client: GatewayWsClient;
  socket: { readyState: number };
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn(() => sendOrder?.push(connId));
  const socket = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    close: vi.fn(),
    send,
  };
  const client = {
    socket: socket as unknown as GatewayWsClient["socket"],
    connect: {
      role: "operator",
      scopes: ["operator.read"],
    } as GatewayWsClient["connect"],
    usesSharedGatewayAuth: false,
  } as GatewayWsClient;
  Object.defineProperty(client, "connId", {
    enumerable: true,
    get: () => {
      reads.count += 1;
      return connId;
    },
  });
  return { client, socket, send };
}

describe("gateway connection state", () => {
  it("uses committed policy for projected and plain session events through tentative activation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
          {
            sessionId: sessionKey,
            updatedAt: 1,
            visibility: "shared",
            createdActor: { type: "human", source: "profile", id: profileId },
          },
        );
      }
      const state = createGatewayConnectionState({
        bootId: "committed-event-policy",
        cfg: restricted,
        getRuntimeConfig: () => runtimeConfig,
      });
      try {
        const projection = await createSessionRowProjection({
          cfg: runtimeConfig,
          getConfig: () => runtimeConfig,
          getPolicyConfig: () => committedConfig,
        });
        const detach = state.attachSessionRowProjection(projection);
        try {
          const peer = makeClient("policy-reader", { count: 0 });
          peer.client.connect.scopes = ["operator.sessions.read"];
          peer.client.connect.client = {
            id: "openclaw-control-ui",
            version: "test",
            platform: "web",
            mode: "webchat",
          };
          peer.client.authenticatedUserProfile = {
            profileId: reader.id,
            displayName: "Reader",
            avatarRevision: "test",
            hasAvatar: false,
            updatedAt: reader.updatedAt,
          };
          prepareGatewayRecipientProfile(peer.client);
          state.clients.add(peer.client);
          const publish = (stage: string, visibleKeys: string[]) => {
            peer.send.mockClear();
            for (const sessionKey of [ownKey, foreignKey]) {
              const scope = { sessionKeys: [sessionKey], agentId: "main" };
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
            const frames = peer.send.mock.calls.map(([frame]): unknown => {
              if (typeof frame !== "string") {
                throw new Error("expected a serialized Gateway event");
              }
              return JSON.parse(frame);
            });
            expect.soft(frames, stage).toEqual(
              visibleKeys.flatMap((sessionKey) => [
                expect.objectContaining({
                  event: "sessions.changed",
                  payload: expect.objectContaining({
                    sessionKey,
                    session: expect.objectContaining({ key: sessionKey }),
                  }),
                }),
                expect.objectContaining({
                  event: "chat",
                  payload: expect.objectContaining({
                    sessionKey,
                    message: { role: "assistant", content: [{ type: "text", text: sessionKey }] },
                  }),
                }),
              ]),
            );
          };
          await projection.ensureMaterialized();
          publish("serving policy", [ownKey]);
          runtimeConfig = relaxed;
          setRuntimeConfigSnapshot(runtimeConfig);
          await projection.ensureMaterialized();
          publish("tentative relaxation", [ownKey]);
          runtimeConfig = restricted;
          setRuntimeConfigSnapshot(runtimeConfig);
          await projection.ensureMaterialized();
          publish("rollback", [ownKey]);
          runtimeConfig = relaxed;
          setRuntimeConfigSnapshot(runtimeConfig);
          await projection.ensureMaterialized();
          committedConfig = relaxed;
          publish("committed relaxation without a projection mark", [ownKey, foreignKey]);
        } finally {
          detach();
          projection.dispose();
        }
      } finally {
        state.mentionInbox.dispose();
      }
    });
  });

  it("advertises online people only through live operator connections", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const state = createGatewayConnectionState({
        bootId: "online-recipients",
        cfg: { agents: { entries: { main: {} } } },
      });
      onTestFinished(() => state.mentionInbox.dispose());
      const reads = { count: 0 };
      const requester = makeClient("requester", reads);
      const recipient = makeClient("recipient", reads);
      for (const [name, peer] of [
        ["requester", requester],
        ["recipient", recipient],
      ] as const) {
        peer.client.connect.client = {
          id: "openclaw-control-ui",
          version: "test",
          platform: "web",
          mode: "webchat",
        };
        peer.client.authenticatedUserProfile = {
          profileId: ensureProfileForEmail(`${name}@example.test`).id,
          displayName: name,
          avatarRevision: "test",
          hasAvatar: false,
          updatedAt: 1,
        };
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
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const scope = { agentId: "main", sessionKey: "agent:main:broadcast-members" };
      await upsertSessionEntryCore(scope, {
        sessionId: "broadcast-members",
        updatedAt: 1,
        visibility: "suggest",
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 1 });
      let broadcastDuringPublication: (() => void) | undefined;
      const stopPublication = sessionChanges.subscribe((change) => {
        if ("sessionKey" in change && change.sessionKey === scope.sessionKey) {
          broadcastDuringPublication?.();
        }
      });
      const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
      const state = createGatewayConnectionState({ bootId: "members", cfg: {} });
      state.attachSessionRowProjection(projection);
      const peers = Array.from({ length: 50 }, (_, index) => {
        const peer = makeClient(`viewer-${index}`, { count: 0 });
        peer.client.authenticatedUserProfile = {
          profileId: "member",
          displayName: null,
          avatarRevision: "test",
          hasAvatar: false,
          updatedAt: 1,
        };
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
      try {
        await projection.ensureMaterialized();
        sessionChanges.emit(scope);
        expect(projection.dirtyRowCount).toBeGreaterThan(0);
        const sql = observeHostDataSql();
        try {
          broadcast();
          expect(peers.every((peer) => peer.send.mock.calls.length === 1)).toBe(true);
          expect(sql.calls.every((call) => call.mock.calls.length === 0)).toBe(true);
        } finally {
          sql.restore();
        }
        removeSessionMember(scope, "member");
        const revokedSql = observeHostDataSql();
        try {
          broadcast();
          expect(peers.every((peer) => peer.send.mock.calls.length === 1)).toBe(true);
          expect(revokedSql.calls.every((call) => call.mock.calls.length === 0)).toBe(true);
        } finally {
          revokedSql.restore();
        }
        addSessionMember(scope, { identityId: "member", addedBy: "owner", addedAt: 2 });
        broadcast();
        expect(peers.every((peer) => peer.send.mock.calls.length === 2)).toBe(true);
        replaceSessionEntrySync(scope, {
          sessionId: "broadcast-replacement",
          updatedAt: 2,
          visibility: "suggest",
          createdActor: { type: "human", source: "profile", id: "owner" },
        });
        const replacementSql = observeHostDataSql();
        try {
          broadcast();
          expect(peers.every((peer) => peer.send.mock.calls.length === 2)).toBe(true);
          expect(replacementSql.calls.every((call) => call.mock.calls.length === 0)).toBe(true);
        } finally {
          replacementSql.restore();
        }
        await projection.ensureMaterialized();
        expect(
          projection.describe({ agentId: scope.agentId, key: scope.sessionKey })?.membership.size,
        ).toBe(0);
        const publicationReads: number[] = [];
        const publicationDirtyRows: number[] = [];
        broadcastDuringPublication = () => {
          const publicationSql = observeHostDataSql();
          try {
            publicationDirtyRows.push(projection.dirtyRowCount);
            state.broadcastToConnIds(
              "task",
              { action: "upserted", task: { id: "task" } },
              targets,
              {
                sessionKeys: [scope.sessionKey],
                agentId: scope.agentId,
              },
            );
            publicationReads.push(
              publicationSql.calls.reduce((count, call) => count + call.mock.calls.length, 0),
            );
          } finally {
            publicationSql.restore();
          }
        };
        for (const [visibility, deliveries] of [
          ["draft", 2],
          ["shared", 3],
          ["draft", 3],
        ] as const) {
          replaceSessionEntrySync(scope, {
            sessionId: "broadcast-replacement",
            updatedAt: 3,
            visibility,
            createdActor: { type: "human", source: "profile", id: "owner" },
          });
          expect(peers.every((peer) => peer.send.mock.calls.length === deliveries)).toBe(true);
        }
        expect(publicationReads).toEqual([0, 0, 0]);
        expect(publicationDirtyRows.every((count) => count > 0)).toBe(true);
      } finally {
        stopPublication();
        projection.dispose();
        state.mentionInbox.dispose();
      }
    });
  });

  it("serves current presence through broadcasts, RPCs, and hello without SQL while display rows are dirty", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const reader = ensureProfileForEmail("presence-reader@example.test");
      const sharedKey = "agent:main:presence-shared";
      const draftKey = "agent:main:presence-draft";
      const incognitoKey = "agent:main:dashboard:incognito-presence";
      const missingKey = "agent:main:presence-missing";
      for (const [sessionKey, visibility] of [
        [sharedKey, "shared"],
        [draftKey, "draft"],
        [incognitoKey, "shared"],
        ["global", "shared"],
      ] as const) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: sessionKey,
            updatedAt: 1,
            visibility,
            createdActor: { type: "human", source: "profile", id: "other-owner" },
            ...(sessionKey === incognitoKey ? { incognito: true } : {}),
          },
        );
      }
      const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
      const state = createGatewayConnectionState({ bootId: "presence-boundaries", cfg });
      const detach = state.attachSessionRowProjection(projection);
      const peers = ["reader", "admin", "trailing-reader"].map((name) => {
        const peer = makeClient(`presence-${name}`, { count: 0 });
        peer.client.connect.scopes = [name === "admin" ? "operator.admin" : "operator.read"];
        peer.client.authenticatedUserProfile = {
          profileId: reader.id,
          displayName: null,
          avatarRevision: "test",
          hasAvatar: false,
          updatedAt: reader.updatedAt,
        };
        prepareGatewayRecipientProfile(peer.client);
        state.clients.add(peer.client);
        return peer;
      });
      const context = createGatewayRequestContext(
        makeContextParams({
          clients: state.clients,
          getSessionRowProjection: state.getSessionRowProjection,
        }),
      );
      const presenceKey = "presence-boundary-watcher";
      upsertPresence(presenceKey, {
        text: presenceKey,
        watchedSessions: [sharedKey, draftKey, incognitoKey, missingKey, "agent:main:global"],
      });
      try {
        await projection.ensureMaterialized();
        const scope = { agentId: "main", sessionKey: sharedKey };
        sessionChanges.emit(scope);
        const verify = (sharedVisible: boolean) => {
          expect(projection.dirtyRowCount).toBeGreaterThan(0);
          const sql = observeHostDataSql();
          try {
            peers.forEach(({ send }) => send.mockClear());
            state.broadcast("presence", { presence: listSystemPresence() });
            for (const [index, peer] of peers.entries()) {
              const watchedSessions =
                index === 1
                  ? [sharedKey, draftKey, incognitoKey, "agent:main:global"]
                  : [...(sharedVisible ? [sharedKey] : []), "agent:main:global"];
              const expected = expect.arrayContaining([
                expect.objectContaining({ text: presenceKey, watchedSessions }),
              ]);
              expect(peer.send).toHaveBeenCalledOnce();
              const frame = peer.send.mock.calls[0]?.[0];
              expect(typeof frame).toBe("string");
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
            expect(sql.queries).toEqual([]);
          } finally {
            sql.restore();
          }
        };
        verify(true);
        replaceSessionEntrySync(scope, {
          sessionId: sharedKey,
          updatedAt: 2,
          visibility: "draft",
          createdActor: { type: "human", source: "profile", id: "other-owner" },
        });
        verify(false);
        replaceSessionEntrySync(scope, {
          sessionId: sharedKey,
          updatedAt: 3,
          visibility: "shared",
        });
        peers[0]!.send.mockImplementationOnce(() => {
          replaceSessionEntrySync(scope, {
            sessionId: sharedKey,
            updatedAt: 4,
            visibility: "draft",
          });
        });
        state.broadcast("presence", { presence: listSystemPresence() });
        const trailing = JSON.parse(String(peers[2]!.send.mock.lastCall?.[0]));
        expect(trailing.payload.presence).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ text: presenceKey, watchedSessions: ["agent:main:global"] }),
          ]),
        );
      } finally {
        upsertPresence(presenceKey, { watchedSessions: undefined });
        detach();
        projection.dispose();
        state.mentionInbox.dispose();
      }
    });
  });

  it("bounds targeted delivery and connection lookups to the requested connection", () => {
    const state = createGatewayConnectionState({
      bootId: "targeted-delivery",
      cfg: {} as OpenClawConfig,
    });
    onTestFinished(() => state.mentionInbox.dispose());
    const reads = { count: 0 };
    for (let index = 0; index < 256; index += 1) {
      state.clients.add(makeClient(`other-${index}`, reads).client);
    }
    const target = makeClient("target", reads);
    state.clients.add(target.client);
    reads.count = 0;

    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);
    expect(state.getBufferedAmount("target")).toBe(0);
    expect(reads.count).toBe(0);

    target.socket.readyState = WebSocket.CLOSING;
    state.broadcastToConnIds("tick", { ts: 2 }, new Set(["target"]));

    expect(target.send).toHaveBeenCalledTimes(1);

    reads.count = 0;
    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(true);
    expect(reads.count).toBe(0);

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
    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(false);
    expect(reads.count).toBe(0);

    secondRequest();
    expect([...state.clients.authorityClients]).not.toContain(target.client);
    state.clients.add(target.client);
    state.clients.clear();
    reads.count = 0;

    expect(state.getBufferedAmount("target")).toBeUndefined();
    expect(state.isConnectionActive("target")).toBe(false);
    expect(reads.count).toBe(0);
  });

  it("preserves connection insertion order for targeted fanout", () => {
    const state = createGatewayConnectionState({
      bootId: "ordered-delivery",
      cfg: {} as OpenClawConfig,
    });
    onTestFinished(() => state.mentionInbox.dispose());
    const reads = { count: 0 };
    const sendOrder: string[] = [];
    state.clients.add(makeClient("first", reads, sendOrder).client);
    state.clients.add(makeClient("unrelated", reads, sendOrder).client);
    state.clients.add(makeClient("last", reads, sendOrder).client);

    state.broadcastToConnIds("tick", { ts: 1 }, new Set(["last", "first"]));

    expect(sendOrder).toEqual(["first", "last"]);
  });
});
