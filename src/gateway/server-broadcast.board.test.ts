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
import { rpcSourceTesting } from "../sessions/session-lifecycle-admission.test-support.js";
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
import { progressCardHandlers } from "./server-methods/progress-card.js";
import { flushPendingSessionsChangedEvents } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext, RespondFn } from "./server-methods/types.js";
import { createLifecycleEventBroadcastHandler } from "./server-session-lifecycle-events.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createSessionObserverAudience } from "./session-observer-audience.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { resolveSessionSharingTargetAsync } from "./session-sharing.js";
import {
  canReceivePreparedSessionEvent,
  createProjectedSessionEventPredicate,
  roleClient,
  rolePolicyConfig,
} from "./session-sharing.test-utils.js";
import { resolveSessionSubscriptionKeys } from "./session-subscription-keys.js";
import { claimRpcSourceForTest, createRpcSourceForTest } from "./test-helpers.rpc-source.js";

type Peer = ReturnType<typeof makeClient>;
const readPeer = (name: string) => makeClient(name, "operator", ["operator.read"]);
const registry = (peers: Peer[]) => new GatewayClientRegistry(peers.map(({ client }) => client));
const frames = (peer: Peer) =>
  peer.socket.send.mock.calls.map(([wire]) => JSON.parse(String(wire)));
const withBoardState = (run: () => Promise<void>) =>
  withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, run);
const humanActor = (id: string) => ({ type: "human" as const, source: "profile" as const, id });
function scopedPeers(names: string[], keys: string[]) {
  const peers = names.map(readPeer);
  const subscribers = createSessionMessageSubscriberRegistry();
  peers.forEach((peer, index) => {
    peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
    if (keys[index]) {
      subscribers.subscribe(peer.client.connId, keys[index]);
    }
  });
  return { peers, subscribers };
}
const subscriberBroadcaster = (
  peers: Peer[],
  subscribers: ReturnType<typeof createSessionMessageSubscriberRegistry>,
) => createGatewayBroadcaster({ clients: registry(peers), sessionMessageSubscribers: subscribers });
const draftEntry = (sessionId: string, owner: string, updatedAt = 1) => ({
  sessionId,
  updatedAt,
  visibility: "draft" as const,
  createdActor: humanActor(owner),
});
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
): EventFilter {
  return createProjectedSessionEventPredicate(cfg, projection);
}

describe("board and progress event session ownership", () => {
  it.each([
    { scope: "global", feature: "progress" },
    { scope: "global", feature: "process" },
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
            ...draftEntry(target.label, peers[index]!.client.authenticatedUserProfile!.profileId),
            label: target.label,
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
        const handlers = { ...progressCardHandlers, ...createBoardHandlers(boardStore) };
        const context = {
          broadcast,
          broadcastToConnIds,
          getRuntimeConfig: () => cfg,
          getSessionEventSubscriberConnIds: () => new Set(peers.map(({ client }) => client.connId)),
          resolveGatewayContext: (): GatewayRequestContext => context,
        } as unknown as GatewayRequestContext;
        bindSessionRowProjection(context, connection.getSessionRowProjection);
        const received = () =>
          peers.map((peer) => frames(peer).map(({ event, payload }) => ({ event, payload })));
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
        };
        try {
          if (feature === "process") {
            const target = { sessionKey: "global", agentId: "work" };
            broadcast("sessions.processes.changed", target, {
              sessionKeys: [target.sessionKey],
              agentId: target.agentId,
            });
            expect(peers.map(frames)).toEqual([
              [expect.objectContaining({ event: "sessions.processes.changed", payload: target })],
              [],
              [],
            ]);
            return;
          }
          if (feature === "progress") {
            const changed = (revision: number | null) => ({
              event: "progressCard.changed",
              payload: { sessionKey: "agent:work:global", revision },
            });
            await invoke("progressCard.put", {
              sessionKey: "global",
              agentId: "work",
              plan: [{ step: "Done", status: "completed" }],
            });
            await invoke("progressCard.put", {
              sessionKey: "global",
              agentId: "work",
              expectedRevision: 1,
            });
            await invoke("progressCard.put", {
              sessionKey: "agent:work:global",
              markdown: "Ordinary session",
            });
            expect(received()).toEqual([[changed(1), changed(null)], [changed(1)], []]);
            expect(await progressCardStore.get("global", "work")).toBeNull();
            expect((await progressCardStore.get("agent:work:global", "work"))?.markdown).toBe(
              "Ordinary session",
            );
            return;
          }

          const changed = (agentId: string, revision: number, widgetName?: string) => ({
            event: "board.changed",
            payload: {
              sessionKey: `agent:${agentId}:global`,
              revision,
              ...(widgetName ? { widget: widgetName } : {}),
            },
          });
          const sessionChanged = (sessionKey: string, agentId: string) => ({
            event: "sessions.changed",
            payload: expect.objectContaining({ sessionKey, agentId, reason: "board" }),
          });
          const rawSession = sessionChanged("global", "work");
          const target = { sessionKey: "global", agentId: "work" };
          await invoke("board.update", {
            ...target,
            ops: [{ kind: "tab_create", tabId: "notes", title: "Notes" }],
          });
          await invoke("board.widget.put", {
            ...target,
            name: "status",
            content: { kind: "html", html: "<p>Working</p>" },
            declared: { tools: ["status.refresh"] },
          });
          const widget = (await boardStore.getSnapshot(target)).widgets[0]!;
          await invoke("board.widget.grant", {
            ...target,
            name: "status",
            decision: "granted",
            revision: widget.revision,
            instanceId: widget.instanceId,
          });
          await invoke("board.update", { ...target, ops: [] });
          await invoke("board.update", {
            sessionKey: "agent:work:global",
            ops: [{ kind: "tab_create", tabId: "ordinary", title: "Ordinary" }],
          });
          await invoke("board.update", {
            sessionKey: "global",
            agentId: "main",
            ops: [{ kind: "tab_create", tabId: "main-notes", title: "Main notes" }],
          });
          expect(received()).toEqual([
            [
              changed("work", 1),
              rawSession,
              changed("work", 2, "status"),
              rawSession,
              changed("work", 3),
            ],
            [changed("work", 1), sessionChanged("agent:work:global", "work")],
            [changed("main", 1), sessionChanged("global", "main")],
          ]);
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
  it.each([
    { event: "sessions.changed", scope: "operator.read" },
    { event: "board.changed", scope: "operator.sessions.read" },
    { event: "board.command", scope: "operator.sessions.write" },
  ])("filters $event after creator replacement ($scope)", async ({ event, scope }) => {
    await withBoardState(async () => {
      const cfg: OpenClawConfig = {};
      setRuntimeConfigSnapshot(cfg);
      const sessionKey = "agent:main:draft-owner-filter";
      const ownerActor = humanActor("profile-owner");
      const successorActor = humanActor("profile-successor");
      const session = { agentId: "main", sessionKey };
      await upsertSessionEntryCore(
        session,
        draftEntry("session-draft-owner-filter", ownerActor.id),
      );
      const owner = readPeer("owner");
      const successor = readPeer("successor");
      owner.client.connect.scopes = [scope];
      successor.client.connect.scopes = [scope];
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
        const payload = {
          sessionKey,
          agentId: "main",
          ...(event === "board.command"
            ? { command: { kind: "focus_tab", tabId: "main" } }
            : event === "board.changed"
              ? { revision: 1 }
              : { reason: "updated" }),
        };
        const broadcast = () =>
          broadcastToConnIds(
            event,
            payload,
            new Set([owner.client.connId, successor.client.connId]),
            { agentId: "main", sessionKeys: [sessionKey] },
          );
        const expectRecipient = (recipient: Peer, rejected: Peer) => {
          expect(rejected.socket.send).not.toHaveBeenCalled();
          expect(frames(recipient)).toEqual([
            expect.objectContaining({
              event,
              payload,
            }),
          ]);
        };

        broadcast();
        expectRecipient(owner, successor);

        const target = await resolveSessionSharingTargetAsync({
          cfg,
          sessionKey,
          agentId: "main",
        });
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
          session,
          draftEntry("session-draft-successor-filter", successorActor.id, 2),
        );
        await projection.ensureMaterialized();
        owner.socket.send.mockClear();
        successor.socket.send.mockClear();
        owner.socket.events.length = 0;
        successor.socket.events.length = 0;

        broadcast();
        expectRecipient(successor, owner);
      } finally {
        projection.dispose();
      }
    });
  });

  it("withholds incognito chat from previously authorized recipients", async () => {
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
      const unrelated = readPeer("unrelated");
      const unscoped = readPeer("unscoped");
      const peers = [subscribed, unrelated, unscoped];
      const identity = roleClient("view", "reader");
      using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
      for (const peer of peers) {
        Object.assign(peer.client, identity, { connect: { ...identity.connect } });
        prepareGatewayRecipientProfile(peer.client);
      }
      const subscribers = createSessionMessageSubscriberRegistry();
      for (const peer of [subscribed, unrelated]) {
        peer.client.connect.caps = [GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS];
        subscribers.subscribe(
          peer.client.connId,
          peer === subscribed ? sessionKey : "agent:main:other",
        );
      }
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
        await upsertSessionEntryCore(target, { ...entry, ...hidden, updatedAt: 2 });
        await projection.ensureMaterialized();
        broadcast("chat", payload);
        expect(peers.map(frames)).toEqual([[frame], [], [frame]]);
      } finally {
        projection.dispose();
      }
    });
  });

  it.each([
    {
      name: "targeted tool mirrors",
      event: "session.tool",
      keys: ["agent:work:global", "other", ""],
      allowed: [0, 2],
    },
    {
      name: "global chat owners",
      event: "chat",
      keys: ["agent:work:global", "agent:main:global", "global"],
      allowed: [0],
    },
    {
      name: "capability-free Browser Copilot",
      event: "chat",
      keys: ["agent:work:global", "agent:other:global"],
      allowed: [0],
    },
  ])("subscription-gates $name", ({ name, event, keys, allowed }) => {
    const { peers, subscribers } = scopedPeers(
      keys.map((_, i) => `peer-${i}`),
      keys,
    );
    if (name === "targeted tool mirrors") {
      peers[2]!.client.connect.caps = [];
    } else if (name === "capability-free Browser Copilot") {
      for (const { client } of peers) {
        client.connect.client = { id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT } as never;
        client.connect.caps = [];
      }
    }
    const broadcaster = subscriberBroadcaster(peers, subscribers);
    const payload = {
      sessionKey: event === "session.tool" ? "agent:work:global" : "global",
      agentId: "work",
      tool: { name: "exec", args: { command: "ls" } },
    };
    if (event === "session.tool") {
      broadcaster.broadcastToConnIds(
        event,
        payload,
        new Set(peers.map(({ client }) => client.connId)),
        { dropIfSlow: true },
      );
    } else {
      broadcaster.broadcast(event, payload, {
        sessionKeys: resolveSessionSubscriptionKeys("global", "work", "main"),
        agentId: "work",
      });
    }
    expect(peers.map(({ socket }) => socket.events)).toEqual(
      keys.map((_, i) => (allowed.includes(i) ? [event] : [])),
    );
  });

  it("preserves event-only recipients selected by the critical observer audience", () => {
    const { peers, subscribers } = scopedPeers(
      ["message", "event-only", "unrelated"],
      ["agent:main:global"],
    );
    const [message, eventOnly, unrelated] = peers;
    const { broadcastToConnIds } = subscriberBroadcaster(peers, subscribers);
    const sessionEventSubscribers = createSessionEventSubscriberRegistry();
    sessionEventSubscribers.subscribe(eventOnly!.client.connId);
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
    const recipients = audience.criticalRecipients("global", "main");
    broadcastToConnIds(
      "session.observer",
      { sessionKey: "global", agentId: "main" },
      recipients,
      audience.deliveryOptions("global", "main"),
    );

    expect(message!.socket.events).toEqual(["session.observer"]);
    expect(eventOnly!.socket.events).toEqual(["session.observer"]);
    expect(unrelated!.socket.events).toEqual([]);
  });

  it("guards suggestion and typing events and forwards payloads to visibility filtering", () => {
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const reader = readPeer("reader");
    const unrelated = readPeer("unrelated");
    const sessionMessageSubscribers = createSessionMessageSubscriberRegistry();
    sessionMessageSubscribers.subscribe("reader", "agent:main:main");
    const canReceiveSessionEvent: EventFilter = (_client, sessionKeys, agentId, event, payload) => {
      expect(sessionKeys).toEqual(["agent:main:main"]);
      expect(agentId).toBe("main");
      expect(payload).toBeDefined();
      return event === "session.typing";
    };
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
      const { connId, authenticatedUserProfile } = peers[index]!.client;
      await upsertSessionEntryCore(target, draftEntry(connId, authenticatedUserProfile!.profileId));
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
    const parentSource = createRpcSourceForTest(
      { projectSessionActive: true },
      {
        runId: "parent-run",
        sessionId: "parent-viewer",
        sessionKey: parent.sessionKey,
        agentId: parent.agentId,
        storeScope: rowProjection.capture({ key: parent.sessionKey, agentId: parent.agentId })!
          .storeTarget.storePath,
      },
    );
    const releaseParentRun = await claimRpcSourceForTest(parentSource);
    rpcSourceTesting.reset([["parent-run", parentSource]]);
    const publish = createLifecycleEventBroadcastHandler({
      getSessionRowProjection: () => rowProjection,
      broadcastToConnIds,
      sessionEventSubscribers: {
        getAll: () => new Set(peers.map(({ client }) => client.connId)),
      },
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
      releaseParentRun();
      detach();
      rowProjection.dispose();
      await connection.mentionInbox.dispose();
      clearSubagentRunsReadCacheForTest();
    }
  });
});

const readScopes = ["read", "write", "admin"];

describe("operator event scope guards", () => {
  it.each<[string, string[], boolean?, string?]>([
    ["board.changed", readScopes],
    ["board.command", readScopes],
    ["sessions.processes.changed", readScopes],
    ["skills.changed", readScopes],
    ["plugins.changed", readScopes],
    ["mcp.app.resourceUpdated", readScopes],
    ["mcp.app.hostContextChanged", readScopes],
    ["talk.voice.change", ["talk", "write", "admin"], true, "talk"],
    ["update.run.changed", ["admin"], false, "admin"],
    ["plugins.install.progress", ["admin"], true, "admin"],
    ["device.pair.setup.completed", ["pairing", "admin"]],
  ])("delivers %s only to authorized recipients", (event, allowed, targeted, nodeScope) => {
    const payload = { marker: event };
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
      clients: registry(targeted ? [...targets, observer] : targets),
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
      } else {
        expect(socket.events).toEqual([]);
      }
    }
  });
});
