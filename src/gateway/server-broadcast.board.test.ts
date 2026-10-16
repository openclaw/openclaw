import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../packages/gateway-protocol/src/client-info.js";
import { mutateSubagentRuns } from "../agents/subagents/registry/subagent-registry-persistence.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  deleteSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { boardStore } from "./board-store.js";
import { prepareGatewayRecipientProfile } from "./expected-profile.js";
import { progressCardStore } from "./progress-card-store.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import {
  createSessionEventSubscriberRegistry,
  createSessionMessageSubscriberRegistry,
} from "./server-chat-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createBoardHandlers } from "./server-methods/board.js";
import { createProgressCardHandlers } from "./server-methods/progress-card.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-events.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { createSessionObserverAudience } from "./session-observer-audience.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import {
  canReceiveSessionEvent as canReceiveSessionEventForClient,
  prepareProjectedSessionSharing,
  resolveSessionSharingTargetAsync,
} from "./session-sharing.js";
import {
  canReceivePreparedSessionEvent,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";
import { resolveSessionStoreIdentity } from "./session-store-key.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";

type Peer = ReturnType<typeof makeClient>;
const readPeer = (name: string) => makeClient(name, "operator", ["operator.read"]);
const registry = (peers: Peer[]) => new GatewayClientRegistry(peers.map(({ client }) => client));
const frames = (peer: Peer) =>
  peer.socket.send.mock.calls.map(([wire]) => JSON.parse(String(wire)));
const withBoardState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);
const humanActor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
function profilePeer(name: string) {
  const peer = readPeer(name);
  Object.assign(peer.client, roleClient("view", name));
  return peer;
}
type EventFilter = NonNullable<
  Parameters<typeof createGatewayBroadcaster>[0]["canReceiveSessionEvent"]
>;

function sharingFilter(
  cfg: OpenClawConfig,
  projection: Awaited<ReturnType<typeof createSessionRowProjection>>,
) {
  return vi.fn<EventFilter>((client, sessionKeys, agentId, event, payload) =>
    canReceiveSessionEventForClient({
      cfg,
      client,
      sessionKeys,
      agentId,
      event,
      payload,
      prepared: {
        sharing: prepareProjectedSessionSharing({
          cfg,
          client,
          isMember: (target, identityId) =>
            projection.hasMembership(target.storePath, target.storeKey, identityId),
        }),
        target: (key, targetAgentId) => {
          const { agentId: ownerAgentId } = resolveSessionStoreIdentity({
            cfg,
            sessionKey: key,
            agentId: targetAgentId,
          });
          return projection.sharingTarget({ key, agentId: ownerAgentId });
        },
      },
    }),
  );
}

describe("board event scope guards", () => {
  it("delivers board events only to read-capable operators", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.read"]);
    const read = readPeer("read");
    const write = makeClient("write", "operator", ["operator.write"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const clients = new GatewayClientRegistry(
      [pairing, node, read, write, admin].map((entry) => entry.client),
    );
    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("board.changed", { sessionKey: "agent:main:main", revision: 1 });
    broadcast("board.command", {
      sessionKey: "agent:main:main",
      command: { kind: "focus_tab", tabId: "main" },
    });

    expect(pairing.socket.events).toEqual([]);
    expect(node.socket.events).toEqual([]);
    expect(read.socket.events).toEqual(["board.changed", "board.command"]);
    expect(write.socket.events).toEqual(["board.changed", "board.command"]);
    expect(admin.socket.events).toEqual(["board.changed", "board.command"]);
  });
});

describe("board and progress event session ownership", () => {
  it.each([
    { scope: "global", feature: "progress" },
    { scope: "per-sender", feature: "board" },
  ] as const)(
    "delivers $feature events only to the canonical draft owner in $scope mode",
    async ({ scope, feature }) => {
      await withBoardState(async () => {
        const cfg: OpenClawConfig = {
          ...rolePolicyConfig(),
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "main" } },
            entries: { main: {}, work: {} },
          },
          session: { scope },
          tools: { exec: { mode: "ask" } },
        };
        setRuntimeConfigSnapshot(cfg, cfg);
        const targets = [
          { sessionKey: "global", agentId: "work", label: "raw-owner" },
          { sessionKey: "agent:work:global", agentId: "work", label: "ordinary-owner" },
          { sessionKey: "global", agentId: "main", label: "other-agent-owner" },
        ];
        const peers = targets.map(({ label }) => profilePeer(label));
        for (const [index, target] of targets.entries()) {
          await upsertSessionEntryCore(target, {
            sessionId: target.label,
            label: target.label,
            updatedAt: 1,
            visibility: "draft",
            createdActor: humanActor(peers[index]!.client.authenticatedUserProfile!.profileId),
          });
        }
        const projection = await createSessionRowProjection({ cfg });
        const connection = createGatewayConnectionState({
          scheduler: createTestGatewayScheduler(),
          bootId: "board-owner-events",
          cfg,
        });
        const detach = connection.attachSessionRowProjection(projection);
        for (const { client } of peers) {
          connection.clients.add(client);
        }
        const { broadcast, broadcastToConnIds } = connection;
        const handlers = { ...createProgressCardHandlers(), ...createBoardHandlers(boardStore) };
        const context = {
          broadcast,
          broadcastToConnIds,
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set(peers.map(({ client }) => client.connId)),
          chatAbortControllers: new Map(),
          resolveGatewayContext: (): GatewayRequestContext => context,
        } as unknown as GatewayRequestContext;
        bindSessionRowProjection(context, connection.getSessionRowProjection);
        const invoke = async (method: string, params: Record<string, unknown>) => {
          const respond = vi.fn<RespondFn>();
          await handlers[method]!({
            req: { type: "req", id: "event-owner", method, params },
            params,
            client: peers[0]!.client,
            isWebchatConnect: () => false,
            respond,
            context,
          });
          await flushPendingSessionsChangedEvents(context);
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          return peers.map(({ socket }) => {
            const receivedFrames = socket.send.mock.calls.map(([frame]) =>
              JSON.parse(String(frame)),
            );
            socket.send.mockClear();
            return receivedFrames.map(({ event, payload }) => ({ event, payload }));
          });
        };
        try {
          if (feature === "progress") {
            const rawWrite = await invoke("progressCard.put", {
              sessionKey: "global",
              agentId: "work",
              plan: [{ step: "Done", status: "completed" }],
            });
            const rawClear = await invoke("progressCard.put", {
              sessionKey: "global",
              agentId: "work",
              expectedRevision: 1,
            });
            const ordinaryWrite = await invoke("progressCard.put", {
              sessionKey: "agent:work:global",
              markdown: "Ordinary session",
            });
            expect(await progressCardStore.get("global", "work")).toBeNull();
            expect((await progressCardStore.get("agent:work:global", "work"))?.markdown).toBe(
              "Ordinary session",
            );
            const changed = (revision: number | null) => ({
              event: "progressCard.changed",
              payload: { sessionKey: "agent:work:global", revision },
            });
            expect({ rawWrite, rawClear, ordinaryWrite }).toEqual({
              rawWrite: [[changed(1)], [], []],
              rawClear: [[changed(null)], [], []],
              ordinaryWrite: [[], [changed(1)], []],
            });
            return;
          }

          const target = { sessionKey: "global", agentId: "work" };
          const rawUpdate = await invoke("board.update", {
            ...target,
            ops: [{ kind: "tab_create", tabId: "notes", title: "Notes" }],
          });
          const rawPut = await invoke("board.widget.put", {
            ...target,
            name: "status",
            content: { kind: "html", html: "<p>Working</p>" },
            declared: { tools: ["status.refresh"] },
          });
          const widget = (await boardStore.getSnapshot(target)).widgets[0]!;
          const rawGrant = await invoke("board.widget.grant", {
            ...target,
            name: "status",
            decision: "granted",
            revision: widget.revision,
            instanceId: widget.instanceId,
          });
          const emptyUpdate = await invoke("board.update", { ...target, ops: [] });
          const ordinaryUpdate = await invoke("board.update", {
            sessionKey: "agent:work:global",
            ops: [{ kind: "tab_create", tabId: "ordinary", title: "Ordinary" }],
          });
          const otherAgentUpdate = await invoke("board.update", {
            sessionKey: "global",
            agentId: "main",
            ops: [{ kind: "tab_create", tabId: "main-notes", title: "Main notes" }],
          });
          expect(await boardStore.getSnapshot(target)).toMatchObject({
            sessionKey: "global",
            revision: 3,
            widgets: [{ name: "status", grantState: "granted" }],
          });
          const changed = (agentId: string, revision: number, widgetName?: string) => ({
            event: "board.changed",
            payload: {
              sessionKey: `agent:${agentId}:global`,
              revision,
              ...(widgetName ? { widget: widgetName } : {}),
            },
          });
          const sessionChanged = (sessionKey: string, agentId: string, label: string) => ({
            event: "sessions.changed",
            payload: expect.objectContaining({
              sessionKey,
              agentId,
              sessionId: label,
              label,
              reason: "board",
              session: expect.objectContaining({ key: sessionKey, agentId, sessionId: label }),
            }),
          });
          const rawSession = sessionChanged("global", "work", "raw-owner");
          expect({
            rawUpdate,
            rawPut,
            rawGrant,
            emptyUpdate,
            ordinaryUpdate,
            otherAgentUpdate,
          }).toEqual({
            rawUpdate: [[changed("work", 1), rawSession], [], []],
            rawPut: [[changed("work", 2, "status"), rawSession], [], []],
            rawGrant: [[changed("work", 3)], [], []],
            emptyUpdate: [[], [], []],
            ordinaryUpdate: [
              [],
              [changed("work", 1), sessionChanged("agent:work:global", "work", "ordinary-owner")],
              [],
            ],
            otherAgentUpdate: [
              [],
              [],
              [changed("main", 1), sessionChanged("global", "main", "other-agent-owner")],
            ],
          });
        } finally {
          await flushPendingSessionsChangedEvents(context);
          detach();
          projection.dispose();
          await connection.mentionInbox.dispose();
        }
      });
    },
  );
});

describe("collaboration event scope guards", () => {
  it("revalidates an authoritative session-generation creator replacement before socket I/O", async () => {
    await withBoardState(async () => {
      const cfg: OpenClawConfig = {};
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:draft-owner-filter";
      const ownerActor = humanActor("profile-owner");
      const successorActor = humanActor("profile-successor");
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "session-draft-owner-filter",
          updatedAt: 1,
          visibility: "draft",
          createdActor: ownerActor,
        },
      );
      const owner = readPeer("owner");
      const successor = readPeer("successor");
      for (const [entry, actor] of [
        [owner, ownerActor],
        [successor, successorActor],
      ] as const) {
        entry.client.authenticatedUserId = actor.id;
        entry.client.authenticatedUserProfile = {
          profileId: actor.id,
          displayName: null,
          hasAvatar: false,
          avatarRevision: "1",
          updatedAt: 1,
        };
      }
      const projection = await createSessionRowProjection({ cfg });
      await projection.ensureMaterialized();
      try {
        const filter = sharingFilter(cfg, projection);
        const { broadcastToConnIds } = createGatewayBroadcaster({
          clients: registry([owner, successor]),
          canReceiveSessionEvent: filter,
        });
        const broadcast = () =>
          broadcastToConnIds(
            "sessions.changed",
            { sessionKey, agentId: "main", reason: "updated" },
            new Set([owner.client.connId, successor.client.connId]),
            { agentId: "main", sessionKeys: [sessionKey] },
          );

        broadcast();

        expect(owner.socket.send).toHaveBeenCalledOnce();
        expect(successor.socket.send).not.toHaveBeenCalled();
        expect(filter.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
          owner.socket.send.mock.invocationCallOrder[0] ?? -1,
        );
        expect(JSON.parse(String(owner.socket.send.mock.calls[0]?.[0]))).toMatchObject({
          event: "sessions.changed",
          payload: { sessionKey, agentId: "main", reason: "updated" },
        });

        const target = await resolveSessionSharingTargetAsync({ cfg, sessionKey, agentId: "main" });
        if (!target) {
          throw new Error("expected the persisted draft session target");
        }
        await expect(
          deleteSessionEntryLifecycle({
            agentId: target.agentId,
            archiveTranscript: false,
            expectedSessionId: "session-draft-owner-filter",
            storePath: target.storePath,
            target: { canonicalKey: target.canonicalKey, storeKeys: target.storeKeys },
          }),
        ).resolves.toMatchObject({ deleted: true });
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-draft-successor-filter",
            updatedAt: 2,
            visibility: "draft",
            createdActor: successorActor,
          },
        );
        await projection.ensureMaterialized();
        owner.socket.send.mockClear();
        successor.socket.send.mockClear();
        owner.socket.events.length = 0;
        successor.socket.events.length = 0;
        filter.mockClear();

        broadcast();

        expect(owner.socket.send).not.toHaveBeenCalled();
        expect(successor.socket.send).toHaveBeenCalledOnce();
        expect(filter.mock.invocationCallOrder.at(-1) ?? Number.MAX_SAFE_INTEGER).toBeLessThan(
          successor.socket.send.mock.invocationCallOrder[0] ?? -1,
        );
        expect(JSON.parse(String(successor.socket.send.mock.calls[0]?.[0]))).toMatchObject({
          event: "sessions.changed",
          payload: { sessionKey, agentId: "main", reason: "updated" },
        });
      } finally {
        projection.dispose();
      }
    });
  });

  it("rechecks incognito visibility only for subscription recipients", async () => {
    const hidden = { visibility: "shared" as const, incognito: true as const };
    await withBoardState(async () => {
      const cfg = rolePolicyConfig();
      setRuntimeConfigSnapshot(cfg, cfg);
      const sessionKey = "agent:main:subscription-filter";
      const target = { agentId: "main", sessionKey };
      const entry = {
        sessionId: "subscription-filter",
        updatedAt: 1,
        visibility: "shared" as const,
        createdActor: humanActor("other-owner"),
      };
      await upsertSessionEntryCore(target, entry);
      const subscribed = readPeer("subscribed");
      const unrelated = Array.from({ length: 32 }, (_entry, i) => readPeer(`unrelated-${i}`));
      const unscoped = readPeer("unscoped");
      const peers = [subscribed, ...unrelated, unscoped];
      const identity = roleClient("view", "reader");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      for (const peer of peers) {
        Object.assign(peer.client, identity, { connect: { ...identity.connect } });
        prepareGatewayRecipientProfile(peer.client);
      }
      const subscribers = createSessionMessageSubscriberRegistry();
      for (const peer of [subscribed, ...unrelated]) {
        peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
        subscribers.subscribe(
          peer.client.connId,
          peer === subscribed ? sessionKey : "agent:main:other",
        );
      }
      const getSubscribers = vi.spyOn(subscribers, "get");
      const projection = await createSessionRowProjection({ cfg });
      await projection.ensureMaterialized();
      try {
        const filter = sharingFilter(cfg, projection);
        const { broadcast } = createGatewayBroadcaster({
          clients: registry(peers),
          sessionMessageSubscribers: subscribers,
          canReceiveSessionEvent: filter,
        });
        const payload = { sessionKey, state: "delta" };
        broadcast("chat", payload);
        const recipientProfileId = identity.authenticatedUserProfile!.profileId;
        const frame = { type: "event", event: "chat", payload, seq: 1, recipientProfileId };
        expect(frames(subscribed)).toEqual([frame]);
        expect(frames(unscoped)).toEqual([frame]);
        for (const peer of unrelated) {
          expect(frames(peer)).toEqual([]);
        }
        expect(filter).toHaveBeenCalledTimes(2);

        await upsertSessionEntryCore(target, { ...entry, ...hidden, updatedAt: 2 });
        await projection.ensureMaterialized();
        getSubscribers.mockClear();
        filter.mockClear();
        broadcast("chat", payload);
        broadcast("tick", {});
        for (const peer of peers) {
          const received = peer === subscribed || peer === unscoped;
          expect(frames(peer)).toEqual([
            ...(received ? [frame] : []),
            {
              type: "event",
              event: "tick",
              payload: {},
              seq: received ? 2 : 1,
              recipientProfileId,
            },
          ]);
        }
        // Hidden recipients skip narration's intent lookups, isolating admission's shared lookup.
        expect(getSubscribers).toHaveBeenCalledExactlyOnceWith(sessionKey);
        expect(filter).toHaveBeenCalledTimes(2);
      } finally {
        projection.dispose();
      }
    });
  });

  it("suppresses session.tool mirrors for scoped clients without a matching subscription", () => {
    const subscribed = readPeer("subscribed");
    const otherSession = readPeer("other-session");
    const unscoped = readPeer("unscoped");
    for (const entry of [subscribed, otherSession]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe(subscribed.client.connId, "agent:main:main");
    sessionMessageSubscribers.subscribe(otherSession.client.connId, "agent:main:other");
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: registry([subscribed, otherSession, unscoped]),
      sessionMessageSubscribers,
    });

    // Mirrors the server-chat session.tool fanout: targeted at all session
    // subscribers, session identity carried in the payload.
    broadcastToConnIds(
      "session.tool",
      { sessionKey: "agent:main:main", tool: { name: "exec", args: { command: "ls" } } },
      new Set(["subscribed", "other-session", "unscoped"]),
      { dropIfSlow: true },
    );

    expect(subscribed.socket.events).toEqual(["session.tool"]);
    // The scoped client subscribed to a different session must not receive
    // another session's tool args via the mirror event.
    expect(otherSession.socket.events).toEqual([]);
    // Unscoped Control UI clients keep full fanout.
    expect(unscoped.socket.events).toEqual(["session.tool"]);
  });

  it("preserves event-only recipients selected by the critical observer audience", () => {
    const message = readPeer("message");
    const eventOnly = readPeer("event-only");
    const unrelated = readPeer("unrelated");
    for (const entry of [message, eventOnly, unrelated]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    subscribers.subscribe(message.client.connId, "agent:main:global");
    sessionEventSubscribers.subscribe(eventOnly.client.connId);
    const audience = createSessionObserverAudience({
      subscribers,
      sessionEventSubscribers,
      isVisible: () => true,
      getConfig: () => ({
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, work: {} },
        },
      }),
    });
    const { broadcastToConnIds } = createGatewayBroadcaster({
      clients: registry([message, eventOnly, unrelated]),
      sessionMessageSubscribers: subscribers,
    });

    const recipients = audience.criticalRecipients("global", "main");
    broadcastToConnIds(
      "session.observer",
      { sessionKey: "global", agentId: "main" },
      recipients,
      audience.deliveryOptions("global", "main"),
    );

    expect(message.socket.events).toEqual(["session.observer"]);
    expect(eventOnly.socket.events).toEqual(["session.observer"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it("keeps global chat events scoped to their owning agent", () => {
    const event = "chat";
    const work = readPeer("work");
    const main = readPeer("main");
    const bareGlobal = readPeer("bare-global");
    for (const entry of [work, main, bareGlobal]) {
      entry.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(work.client.connId, "agent:work:global");
    subscribers.subscribe(main.client.connId, "agent:main:global");
    subscribers.subscribe(bareGlobal.client.connId, "global");
    const { broadcast } = createGatewayBroadcaster({
      clients: registry([work, main, bareGlobal]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast(
      event,
      { sessionKey: "global", agentId: "work" },
      {
        sessionKeys: resolveSessionSubscriptionKeys("global", "work", "main"),
        agentId: "work",
      },
    );

    expect(work.socket.events).toEqual([event]);
    expect(main.socket.events).toEqual([]);
    expect(bareGlobal.socket.events).toEqual([]);
  });

  it("subscription-gates Browser Copilot without relying on the capability bit", () => {
    const subscribed = readPeer("subscribed");
    const unrelated = readPeer("unrelated");
    for (const entry of [subscribed, unrelated]) {
      entry.client.connect.client = { id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT } as never;
      entry.client.connect.caps = [];
    }
    const subscribers = createSessionMessageSubscriberRegistry();
    subscribers.subscribe(subscribed.client.connId, "agent:work:global");
    subscribers.subscribe(unrelated.client.connId, "agent:other:global");
    const { broadcast } = createGatewayBroadcaster({
      clients: registry([subscribed, unrelated]),
      sessionMessageSubscribers: subscribers,
    });

    broadcast(
      "chat",
      { sessionKey: "global", agentId: "work" },
      {
        sessionKeys: ["agent:work:global"],
        agentId: "work",
      },
    );

    expect(subscribed.socket.events).toEqual(["chat"]);
    expect(unrelated.socket.events).toEqual([]);
  });

  it("guards suggestion and typing events and forwards payloads to visibility filtering", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const reader = readPeer("reader");
    const unrelated = readPeer("unrelated");
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("reader", "agent:main:main");
    const canReceiveSessionEvent = vi.fn(
      (
        _client: GatewayWsClient,
        sessionKeys: readonly string[],
        agentId: string | undefined,
        event: string | undefined,
        payload: unknown,
      ) => {
        expect(sessionKeys).toEqual(["agent:main:main"]);
        expect(agentId).toBe("main");
        expect(payload).toBeDefined();
        return event === "session.typing";
      },
    );
    const { broadcast } = createGatewayBroadcaster({
      clients: registry([pairing, reader, unrelated]),
      canReceiveSessionEvent,
      sessionMessageSubscribers,
    });

    broadcast("session.suggestion", {
      suggestion: { sessionKey: "agent:main:main", agentId: "main" },
    });
    broadcast(
      "session.typing",
      {
        sessionKey: "agent:main:main",
        agentId: "main",
        typing: true,
      },
      { sessionKeys: ["agent:main:main"], agentId: "main" },
    );

    expect(pairing.socket.events).toEqual([]);
    expect(reader.socket.events).toEqual(["session.typing"]);
    expect(unrelated.socket.events).toEqual([]);
    expect(canReceiveSessionEvent).toHaveBeenCalledTimes(3);
  });
});

it("delivers committed collector updates to a parent-only cross-agent viewer", async () => {
  await withBoardState(async () => {
    const cfg: OpenClawConfig = {
      ...rolePolicyConfig(),
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    setRuntimeConfigSnapshot(cfg, cfg);
    clearSubagentRunsReadCacheForTest();
    const peers = ["parent-viewer", "child-viewer"].map(profilePeer);
    const parent = { sessionKey: "global", agentId: "ops" };
    const child = { sessionKey: "agent:research:subagent:collector", agentId: "research" };
    for (const [index, target] of [parent, child].entries()) {
      await upsertSessionEntryCore(target, {
        sessionId: peers[index]!.client.connId,
        updatedAt: 1,
        visibility: "draft",
        createdActor: humanActor(peers[index]!.client.authenticatedUserProfile!.profileId),
      });
    }
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    expect(
      await canReceivePreparedSessionEvent({
        cfg,
        client: peers[0]!.client,
        sessionKeys: [child.sessionKey],
        agentId: child.agentId,
        event: "sessions.changed",
      }),
    ).toBe(false);
    const rowProjection = await createSessionRowProjection({ cfg });
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "collector-events",
      cfg,
    });
    const detach = connection.attachSessionRowProjection(rowProjection);
    peers.forEach(({ client }) => connection.clients.add(client));
    const { broadcastToConnIds } = connection;
    const publications: Promise<void>[] = [];
    const publish = createLifecycleEventBroadcastHandler({
      getSessionRowProjection: () => rowProjection,
      broadcastToConnIds,
      sessionEventSubscribers: {
        getAll: () => new Set(peers.map(({ client }) => client.connId)),
      },
      chatAbortControllers: new Map([
        [
          "parent-run",
          {
            controller: new AbortController(),
            sessionId: "parent-viewer",
            sessionKey: parent.sessionKey,
            agentId: parent.agentId,
            startedAtMs: 1,
            expiresAtMs: Date.now() + 60_000,
            projectSessionActive: true,
            executionStarted: true,
          },
        ],
      ]),
    });
    const unsubscribe = onSessionLifecycleEvent((event) => {
      publications.push(publish(event));
    });
    const run: SubagentRunRecord = {
      runId: "collector",
      childSessionKey: child.sessionKey,
      requesterSessionKey: "agent:research:private-delivery",
      requesterDisplayKey: "private child",
      swarmRequesterSessionKey: parent.sessionKey,
      requesterAgentId: parent.agentId,
      collect: true,
      groupId: "opaque-batch",
      createdAt: 1,
      cleanup: "keep",
      task: "child-private task",
      execution: { status: "queued" },
      completion: { required: false },
      delivery: { status: "not_required" },
    };
    const runs = new Map<string, SubagentRunRecord>();
    try {
      for (const next of [
        run,
        { ...run, execution: { status: "running", startedAt: 2 } },
        {
          ...run,
          execution: { status: "terminal", endedAt: 3, outcome: { status: "error" } },
          collectorCompletion: {
            status: "failed",
            structured: { private: "child-private result" },
          },
        },
        null,
      ] satisfies Array<SubagentRunRecord | null>) {
        await mutateSubagentRuns(
          [run.runId],
          () => ({
            value: undefined,
            postimages: new Map([[run.runId, next]]),
          }),
          { runs },
        );
      }
      await Promise.all(publications);
      expect(peers[0]!.socket.events).toEqual(Array(4).fill("sessions.changed"));
      expect(peers[1]!.socket.events).toEqual([]);
      for (const [raw] of peers[0]!.socket.send.mock.calls) {
        const event = JSON.parse(raw);
        expect(event.payload).toMatchObject({
          sessionKey: "global",
          agentId: "ops",
          reason: "swarm",
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["parent-run"],
        });
        expect(event.payload).not.toHaveProperty("phase");
        expect(raw).not.toContain("child-private");
        expect(raw).not.toContain(child.sessionKey);
      }
    } finally {
      unsubscribe();
      await Promise.allSettled(publications);
      detach();
      rowProjection.dispose();
      await connection.mentionInbox.dispose();
      clearSubagentRunsReadCacheForTest();
    }
  });
});

const readScopes = ["read", "write", "admin"];

describe("operator event scope guards", () => {
  it.each([
    { event: "skills.changed", payload: { reason: "remote-node" }, allowed: readScopes },
    { event: "plugins.changed", payload: { generation: 1 }, allowed: readScopes },
    { event: "mcp.app.resourceUpdated", payload: { reason: "remote-node" }, allowed: readScopes },
    {
      event: "mcp.app.hostContextChanged",
      payload: { reason: "remote-node" },
      allowed: readScopes,
    },
    {
      event: "talk.voice.change",
      payload: {
        phase: "requested",
        changeId: "change-1",
        voiceSessionId: "voice-1",
        sessionKey: "main",
        voice: "ember",
      },
      allowed: ["talk", "write", "admin"],
      targeted: true,
      nodeScope: "talk",
    },
    {
      event: "update.run.changed",
      payload: { runId: "run", phase: "staging", status: "running", updatedAtMs: 1 },
      allowed: ["admin"],
      nodeScope: "admin",
    },
    {
      event: "plugins.install.progress",
      payload: {
        activityId: "install-activity",
        stage: "runtime",
        status: "started",
        requestId: "install-request",
      },
      allowed: ["admin"],
      targeted: true,
      nodeScope: "admin",
    },
    {
      event: "device.pair.setup.completed",
      payload: { setupId: "setup-123", deviceId: "device-123", access: "limited", ts: 1 },
      allowed: ["pairing", "admin"],
    },
  ])(
    "delivers $event only to authorized recipients",
    ({ event, payload, allowed, targeted, nodeScope }) => {
      const operators = ["pairing", "read", "write", "admin", "talk"].map((scope) =>
        makeClient(scope, "operator", [`operator.${scope}`]),
      );
      const session = makeClient("session", "operator", [
        "operator.sessions.read",
        "operator.sessions.write",
      ]);
      const node = makeClient("node", "node", [`operator.${nodeScope ?? "read"}`]);
      const targets = [...operators, session, node];
      const observer = makeClient("observer", "operator", [`operator.${allowed[0]}`]);
      const broadcaster = createGatewayBroadcaster({
        clients: new GatewayClientRegistry(
          (targeted ? [...targets, observer] : targets).map(({ client }) => client),
        ),
      });
      if (targeted) {
        broadcaster.broadcastToConnIds(
          event,
          payload,
          new Set(targets.map(({ client }) => client.connId)),
        );
        expect(observer.socket.send).not.toHaveBeenCalled();
      } else {
        broadcaster.broadcast(event, payload);
      }
      for (const { client, socket } of targets) {
        if (allowed.includes(client.connId)) {
          expect(socket.events).toEqual([event]);
          expect(socket.send).toHaveBeenCalledOnce();
          expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({
            type: "event",
            event,
            seq: 1,
            payload,
          });
        } else {
          expect(socket.events).toEqual([]);
          expect(socket.send).not.toHaveBeenCalled();
        }
      }
    },
  );
});
