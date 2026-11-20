import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createPreparedTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { createOperatorApprovalSessionEventRuntime } from "./operator-approval-session-events.js";
import { createPendingRecord } from "./operator-approval-session-events.test-support.js";
import * as approvalStore from "./operator-approval-store.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import {
  broadcastApprovalResolvedEvent,
  buildRequestedApprovalEvent,
} from "./server-methods/approval-shared.js";
import { sessionSubscriptionHandlers } from "./server-methods/sessions-subscriptions.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { gatewayConnect, dispatchProfile } from "./server/client-fixtures.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

const sessionKey = "agent:main:participation";
const binding = { creatorProfileId: "creator", participantProfileId: "participant", sessionKey };

function audience() {
  return ["creator", "admin", "participant", "unrelated", "reader"].map((id) => {
    const scopes =
      id === "admin"
        ? ["operator.admin"]
        : id === "creator" || id === "reader"
          ? ["operator.sessions.read"]
          : ["operator.approvals"];
    const entry = makeClient(id, "operator", scopes);
    entry.client.connect = gatewayConnect(scopes);
    entry.client.connect.device = { id } as typeof entry.client.connect.device;
    entry.client.authenticatedUserProfile = dispatchProfile(id);
    return entry;
  });
}

afterEach(() => vi.restoreAllMocks());

it("delivers live participation approval requests and resolutions only to the creator/admin", async (test) => {
  const fixture = await createPreparedTestApprovalManager(test);
  await fixture.run(() =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { manager } = fixture;
      const entries = audience();
      const clients = new GatewayClientRegistry();
      entries.forEach(({ client }) => clients.add(client));
      let disclosed = true;
      const broadcaster = createGatewayBroadcaster({
        clients,
        canReceiveSessionEvent: () => disclosed,
      });
      const context = createGatewayRequestContext(
        makeContextParams({ clients, execApprovalManager: manager, ...broadcaster }),
      );
      const record = manager.create({ command: "echo private", sessionKey }, 60_000);
      record.participation = binding;
      record.requestedByDeviceId = "participant";
      const registered = await manager.register(record, 60_000);
      const recipients = context.getApprovalClientConnIds!({ approvalKind: "exec", record });
      expect([...recipients]).toEqual(["creator", "admin"]);
      context.broadcastToConnIds(
        "exec.approval.requested",
        buildRequestedApprovalEvent(record),
        recipients,
      );
      expect(entries.map(({ socket }) => socket.events)).toEqual([
        ["exec.approval.requested"],
        ["exec.approval.requested"],
        [],
        [],
        [],
      ]);
      await manager.resolve(record.id, "deny", "creator");
      await registered.decision;
      broadcastApprovalResolvedEvent({
        approvalKind: "exec",
        context,
        record,
        event: {
          id: record.id,
          decision: "deny",
          resolvedBy: "creator",
          ts: Date.now(),
          request: record.request,
        },
      });
      expect(entries.map(({ socket }) => socket.events)).toEqual([
        ["exec.approval.requested", "exec.approval.resolved"],
        ["exec.approval.requested", "exec.approval.resolved"],
        [],
        [],
        [],
      ]);
      disclosed = false;
      context.broadcastToConnIds(
        "exec.approval.requested",
        buildRequestedApprovalEvent(record),
        recipients,
      );
      expect(entries[0]!.socket.events).toHaveLength(2);
    }),
  );
});

it("filters live session delivery and reconnect replay by exact live creator authority", async (test) => {
  let runtime: ReturnType<typeof createOperatorApprovalSessionEventRuntime> | undefined;
  const fixture = await createPreparedTestApprovalManager(test, {
    onLifecycle: (event) => runtime?.publish(event),
  });
  await fixture.run(() =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { manager, databaseOptions } = fixture;
      const prepare = approvalStore.prepareOperatorApprovalReplay;
      vi.spyOn(approvalStore, "prepareOperatorApprovalReplay").mockImplementation((input) =>
        prepare({ ...input, databaseOptions }),
      );
      const entries = audience();
      const clients = new GatewayClientRegistry();
      const subscribers = createSessionMessageSubscriberRegistry();
      entries.forEach(({ client }) => {
        clients.add(client);
        subscribers.subscribe(client.connId, sessionKey, { includeApprovals: true });
      });
      const broadcaster = createGatewayBroadcaster({ clients, canReceiveSessionEvent: () => true });
      let available = true;
      runtime = createOperatorApprovalSessionEventRuntime({
        clients,
        sessionMessageSubscribers: subscribers,
        broadcastToConnIds: broadcaster.broadcastToConnIds,
        getLiveManager: () => (available ? manager : undefined),
      });
      const record = manager.create({ command: "echo private", sessionKey }, 60_000);
      record.participation = binding;
      record.approvalReviewerDeviceIds = ["participant", "unrelated"];
      const registered = await manager.register(record, 60_000);
      expect(entries.map(({ socket }) => socket.events)).toEqual([
        ["session.approval"],
        ["session.approval"],
        [],
        [],
        [],
      ]);
      for (const { client } of entries) {
        const replay = await runtime.replay(sessionKey, client);
        expect(
          replay.replay.approvals.map(({ id }) => id),
          client.connId,
        ).toEqual(["creator", "admin"].includes(client.connId) ? [record.id] : []);
        expect(replay.isCurrent()).toBe(true);
        replay.release();
      }
      const creator = entries[0]!.client;
      setRuntimeConfigSnapshot({ agents: { entries: { main: {} } } });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId: "participation-session",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "creator" },
        },
      );
      const context = createGatewayRequestContext(
        makeContextParams({
          clients,
          execApprovalManager: manager,
          ...broadcaster,
          approvalSessionEvents: { replay: runtime.replay },
          subscribeSessionMessageEvents: subscribers.subscribe,
        }),
      );
      const respond = vi.fn();
      await sessionSubscriptionHandlers["sessions.messages.subscribe"]!({
        req: { type: "req", id: "creator-reconnect", method: "sessions.messages.subscribe" },
        params: { key: sessionKey, includeApprovals: true },
        client: creator,
        context,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          subscribed: true,
          approvalReplay: expect.objectContaining({
            approvals: [expect.objectContaining({ id: record.id })],
          }),
        }),
        undefined,
      );
      const replay = await runtime.replay(sessionKey, creator);
      creator.authenticatedUserProfile = dispatchProfile("unrelated");
      expect(() => replay.isCurrent()).toThrow("authority");
      replay.release();
      creator.authenticatedUserProfile = dispatchProfile("creator");
      available = false;
      const missing = await runtime.replay(sessionKey, creator);
      expect(missing.replay.approvals).toEqual([]);
      missing.release();
      available = true;
      await manager.resolve(record.id, "deny", "creator");
      await registered.decision;
      expect(entries.map(({ socket }) => socket.events)).toEqual([
        ["session.approval", "session.approval"],
        ["session.approval", "session.approval"],
        [],
        [],
        [],
      ]);
      const ordinary = manager.create({ command: "echo ordinary", sessionKey }, 60_000);
      ordinary.approvalReviewerDeviceIds = ["unrelated"];
      await manager.register(ordinary, 60_000);
      expect(entries.map(({ socket }) => socket.events.length)).toEqual([2, 3, 0, 1, 0]);
      const ordinaryReplay = await runtime.replay(sessionKey, entries[3]!.client);
      expect(ordinaryReplay.replay.approvals.map(({ id }) => id)).toEqual([ordinary.id]);
      ordinaryReplay.release();
    }),
  );
});

it("rejects a changed creator identity while replay preparation awaits", async (test) => {
  const fixture = await createPreparedTestApprovalManager(test);
  await fixture.run(() =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { manager, databaseOptions } = fixture;
      const record = manager.create({ command: "echo private", sessionKey }, 60_000);
      record.participation = binding;
      await manager.register(record, 60_000);
      const selected = createDeferredCore();
      const finish = createDeferredCore();
      const prepare = approvalStore.prepareOperatorApprovalReplay;
      vi.spyOn(approvalStore, "prepareOperatorApprovalReplay").mockImplementationOnce(
        async (input) => {
          const snapshot = await prepare({ ...input, databaseOptions });
          selected.resolve();
          await finish.promise;
          return snapshot;
        },
      );
      const client = audience()[0]!.client;
      const runtime = createOperatorApprovalSessionEventRuntime({
        clients: [client],
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        broadcastToConnIds: vi.fn(),
        getLiveManager: () => manager,
      });
      const pending = runtime.replay(sessionKey, client);
      const rejected = expect(pending).rejects.toThrow("authority");
      try {
        await selected.promise;
        client.authenticatedUserProfile = dispatchProfile("participant");
      } finally {
        finish.resolve();
      }
      await rejected;
    }),
  );
});

it("selects entitled exec records before unrelated reviewers can exhaust replay", async (test) => {
  const fixture = await createPreparedTestApprovalManager(test);
  await fixture.run(() =>
    withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { manager } = fixture;
      const entries = audience();
      const ordinary = manager.create({ command: "ordinary", sessionKey }, 60_000);
      ordinary.approvalReviewerDeviceIds = ["unrelated"];
      await manager.register(ordinary, 60_000);
      const participating = manager.create({ command: "participating", sessionKey }, 60_000);
      participating.participation = binding;
      await manager.register(participating, 60_000);
      const rows = [
        ...Array.from({ length: 1_000 }, (_, index) =>
          createPendingRecord({
            id: `other-${index}`,
            reviewerDeviceIds: ["someone-else"],
            audienceSessionKeys: [sessionKey],
            expiresAtMs: Date.now() + 60_000,
          }),
        ),
        ...[ordinary, participating].map((record) =>
          Object.assign(
            createPendingRecord({
              id: record.id,
              reviewerDeviceIds: record.approvalReviewerDeviceIds ?? [],
              audienceSessionKeys: [sessionKey],
              expiresAtMs: record.expiresAtMs,
            }),
            { runtimeEpoch: manager.runtimeEpoch },
          ),
        ),
      ];
      vi.spyOn(approvalStore, "prepareOperatorApprovalReplay").mockImplementation(
        async (input) => ({
          outcome: "pending",
          isCurrent: () => true,
          records: rows
            .filter(
              (row) =>
                input?.execApprovalIds === undefined || input.execApprovalIds.includes(row.id),
            )
            .slice(0, input?.limit),
        }),
      );
      const runtime = createOperatorApprovalSessionEventRuntime({
        clients: entries.map((entry) => entry.client),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
        broadcastToConnIds: vi.fn(),
        getLiveManager: () => manager,
      });
      for (const [client, id] of [
        [entries[0]!.client, participating.id],
        [entries[3]!.client, ordinary.id],
      ] as const) {
        const replay = await runtime.replay(sessionKey, client);
        expect(replay.replay.approvals.map((approval) => approval.id)).toEqual([id]);
        expect(replay.replay.truncated).toBe(false);
        expect(replay.isCurrent()).toBe(true);
        replay.release();
      }
    }),
  );
});
