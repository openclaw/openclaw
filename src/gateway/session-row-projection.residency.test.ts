import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  addSessionMember,
  removeSessionMember,
} from "../config/sessions/session-sharing-store.native.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { createSessionMessageSubscriberRegistry } from "./server-chat-state.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { startGatewayMaintenanceTimers } from "./server-maintenance.js";
import {
  emitSessionsChanged,
  flushPendingSessionsChangedEvents,
} from "./server-methods/session-change-event.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import { createSessionRowEventPeer } from "./session-row-event.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { listRows, writeRow } from "./session-row-projection-read-fixtures.test-support.js";
import { ready } from "./session-row-projection-record.js";
import { holdSubagentExecution } from "./session-row-projection.read-fixture.test-support.js";
import {
  appendProjectionMessages,
  withSessionRowProjectionState,
} from "./session-row-projection.test-support.js";
import { rolePolicyConfig } from "./session-sharing.test-utils.js";
import { createSessionViewerPresenceDeclarations } from "./session-viewer-presence.js";
import { createGatewayMaintenanceStateForTest } from "./test-helpers.maintenance-state.js";

it("releases terminal display rows after a broad visit without losing parent or search metadata", async () => {
  await withSessionRowProjectionState(async (create, _state, cleanup) => {
    const clock = createGatewaySchedulerClock(Date.now());
    using clockNow = vi.spyOn(Date, "now");
    clockNow.mockImplementation(clock.clock.now);
    const expire = (projection: Parameters<typeof listRows>[0]) => {
      clock.setTime(clock.clock.now() + 10 * 60_000);
      projection.sweepMaterializedRows(clock.clock.now());
    };
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const parent = "agent:main:residency-parent";
    writeRow(parent);
    const children = Array.from(
      { length: 120 },
      (_, index) => `agent:main:residency-child-${index}`,
    );
    for (const [index, key] of children.entries()) {
      writeRow(key, {
        status: (["done", "killed", "failed", "interrupted", "timeout"] as const)[index % 5],
        label: `Finished child ${index}`,
        spawnedBy: parent,
      });
    }
    const projection = await create({ cfg, modelCatalog: [] });
    const page = await listRows(projection, { limit: 200 });
    expect(page.sessions).toHaveLength(121);
    expect(projection.selectEntries().filter(ready)).toHaveLength(121);
    const timers = startGatewayMaintenanceTimers({
      ...createGatewayMaintenanceStateForTest(),
      scheduler: createTestGatewayScheduler(clock.clock),
      isNixMode: true,
      resolveGatewayContext: () => bindSessionRowProjection(requestContext(cfg), () => projection),
    });
    cleanup.defer(async () => {
      await timers.stopPeriodicTasks();
      await timers.skillUsageCleanup();
    });
    await clock.advanceBy(9 * 60_000);
    expect(projection.selectEntries().filter(ready)).toHaveLength(121);
    // A recently read child survives while the rest of the broad page expires.
    const recent = { agentId: "main", key: children[0]! };
    projection.snapshot(recent);
    await clock.advanceBy(2 * 60_000);
    expect(projection.capture(recent)?.materialized).toBeDefined();
    expect(projection.selectEntries().filter(ready)).toHaveLength(2);
    const sharing = await projection.withPreparedExactRows(
      () => projection.selectEntries().map(({ agentId, key }) => ({ agentId, key })),
      () => projection.sharingRevision,
    );
    for (let wave = 0; wave < 5; wave++) {
      await listRows(projection, { limit: 200 });
      expect(projection.selectEntries().filter(ready)).toHaveLength(121);
      expire(projection);
      expect(projection.selectEntries().filter(ready)).toHaveLength(1);
      expect(projection.sharingRevision).toBe(sharing);
    }
    expire(projection);
    const cold = projection.selectEntries().find((row) => row.key !== parent && !row.materialized);
    expect(cold).toBeDefined();
    expect(projection.selectEntries({ parentSessionKey: parent }).map((row) => row.key)).toEqual(
      expect.arrayContaining(children),
    );
    const search = await listRows(projection, { search: cold!.entry!.label, limit: 200 });
    expect(search.sessions.map((row) => row.key)).toContain(cold!.key);
    await listRows(projection, { limit: 200 });
    expire(projection);
    const exact = projection
      .selectEntries()
      .find((row) => row.key !== parent && !row.materialized)!;
    expect(exact).toBeDefined();
    const snapshot = await projection.withPreparedExactRows(
      () => [{ agentId: "main", key: exact.key }],
      () => projection.snapshot({ agentId: "main", key: exact.key }),
    );
    expect(snapshot.row).toMatchObject({
      key: exact.key,
      status: exact.entry!.status,
      label: exact.entry!.label,
    });
  }, true);
});

it("retains runtime, recovery, delivery, cleanup and client custody while trimming finished rows", async () => {
  await withSessionRowProjectionState(async (create, _state, cleanup) => {
    const clock = createGatewaySchedulerClock(Date.now());
    using clockNow = vi.spyOn(Date, "now");
    clockNow.mockImplementation(clock.clock.now);
    const expire = (projection: Parameters<typeof listRows>[0]) => {
      clock.setTime(clock.clock.now() + 10 * 60_000);
      projection.sweepMaterializedRows(clock.clock.now());
    };
    const cfg = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const subscribers = createSessionMessageSubscriberRegistry();
    const key = (name: string) => `agent:main:protected-${name}`;
    const names = ["active", "queued", "recovery", "delivery", "cleanup", "subscribed", "viewed"];
    for (const name of names) {
      writeRow(key(name), { status: "done", updatedAt: 1_000 });
    }
    const peer = createSessionRowEventPeer(
      ensureProfileForEmail("watcher@example.test"),
      "watcher",
      1,
    );
    const watches = createSessionViewerPresenceDeclarations({
      clients: new GatewayClientRegistry([peer.client]),
      publishPresence: () => {},
    });
    cleanup.defer(watches.stop);
    watches.replace(peer.client.connId, [key("viewed")]);
    const running = holdSubagentExecution("residency-execution", key("active"));
    cleanup.defer(() => running[Symbol.dispose]());
    for (const name of ["queued", "recovery", "delivery", "cleanup"]) {
      const run = createSubagentRunRecord({
        runId: `residency-${name}`,
        childSessionKey: key(name),
        childAgentId: "main",
        execution:
          name === "queued"
            ? { status: "queued" }
            : { status: "terminal", endedAt: 2, outcome: { status: "ok" } },
        cleanupCompletedAt: name === "cleanup" ? undefined : 3,
        ...(name === "recovery" ? { terminalOwner: "interrupted-recovery" as const } : {}),
        delivery: { status: name === "delivery" ? "pending" : "not_required" },
      });
      subagentRuns.set(run.runId, run);
      cleanup.defer(() => {
        subagentRuns.delete(run.runId);
      });
    }
    subscribers.subscribe("reader", key("subscribed"));
    for (let index = 0; index < 120; index++) {
      writeRow(`agent:main:finished-${index}`, { status: "done", updatedAt: index + 2 });
    }
    const projection = await create({
      cfg,
      modelCatalog: [],
      observers: {
        has: (row) => subscribers.get(row.key).size > 0 || watches.has(row.key),
      },
    });
    await listRows(projection, { limit: 200 });
    expire(projection);
    for (const name of names) {
      expect(
        projection.capture({ agentId: "main", key: key(name) })?.materialized,
        name,
      ).toBeDefined();
    }
    expect(projection.selectEntries().filter(ready)).toHaveLength(7);
    subscribers.unsubscribeAll("reader");
    projection.sweepMaterializedRows(clock.clock.now());
    expect(projection.selectEntries().filter(ready)).toHaveLength(6);
  }, true);
});

it("promotes a cold row for event publication and enforces visibility revocation from cold metadata", async () => {
  await withSessionRowProjectionState(async (create, _state, cleanup) => {
    const clock = createGatewaySchedulerClock(Date.now());
    using clockNow = vi.spyOn(Date, "now");
    clockNow.mockImplementation(clock.clock.now);
    const expire = () => {
      clock.setTime(clock.clock.now() + 10 * 60_000);
      projection.sweepMaterializedRows(clock.clock.now());
    };
    const cfg = { ...rolePolicyConfig(), agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    const owner = ensureProfileForEmail("residency-owner@example.test");
    const viewer = ensureProfileForEmail("residency-viewer@example.test");
    const entry = {
      status: "done" as const,
      visibility: "shared" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner.id },
    };
    for (let index = 0; index < 120; index++) {
      writeRow(`agent:main:event-residency-${index}`, entry);
    }
    const projection = await create({ cfg, modelCatalog: [] });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const connection = createGatewayConnectionState({
      scheduler: createTestGatewayScheduler(),
      bootId: "residency-events",
      cfg,
    });
    cleanup.defer(() => connection.mentionInbox.dispose());
    cleanup.defer(connection.attachSessionRowProjection(projection));
    const peer = createSessionRowEventPeer(viewer, "residency-viewer", 1);
    connection.clients.add(peer.client);
    connection.sessionEventSubscribers.subscribe(peer.client.connId);
    context.broadcastToConnIds = connection.broadcastToConnIds;
    context.getSessionEventSubscriberConnIds = connection.sessionEventSubscribers.getAll;
    context.getSessionMessageSubscriberConnIds = connection.sessionMessageSubscribers.get;
    cleanup.defer(() => flushPendingSessionsChangedEvents(context));
    await listRows(projection, { limit: 200 });
    expire();
    const cold = projection.selectEntries().find((row) => !row.materialized)!;
    expect(cold).toBeDefined();
    writeRow(cold.key, { ...entry, status: "failed", label: "Changed after demotion" });
    await appendProjectionMessages(
      { agentId: "main", sessionKey: cold.key, sessionId: cold.entry!.sessionId },
      { role: "assistant", content: "Synthetic post-demotion answer" },
    );
    await projection.ensureMaterialized();
    expect(projection.capture({ agentId: "main", key: cold.key })?.materialized).toBeUndefined();
    emitSessionsChanged(context, { sessionKey: cold.key, agentId: "main", reason: "patch" });
    await flushPendingSessionsChangedEvents(context);
    const frames = peer.send.mock.calls.map(([raw]) => JSON.parse(raw));
    expect(
      frames.find((frame) => frame.event === "sessions.changed")?.payload.session,
    ).toMatchObject({
      key: cold.key,
      status: "failed",
      label: "Changed after demotion",
      lastMessagePreview: "Synthetic post-demotion answer",
    });
    await listRows(projection, { limit: 200 });
    expire();
    const revoked = projection.selectEntries().find((row) => !row.materialized)!;
    expect(revoked).toBeDefined();
    writeRow(revoked.key, { ...entry, visibility: "draft" });
    expire();
    expect(projection.capture({ agentId: "main", key: revoked.key })?.materialized).toBeUndefined();
    const visible = await listRows(projection, { limit: 200 }, { context, client: peer.client });
    expect(visible.sessions.map((row) => row.key)).not.toContain(revoked.key);
    const scope = { agentId: "main", sessionKey: revoked.key };
    addSessionMember(scope, { identityId: viewer.id, addedBy: owner.id, addedAt: 1 });
    writeRow(revoked.key, { ...entry, visibility: "read-only", updatedAt: 1_000 });
    await listRows(projection, { limit: 200 });
    expire();
    expect(projection.capture({ agentId: "main", key: revoked.key })?.materialized).toBeUndefined();
    const shared = await listRows(projection, { limit: 200 }, { context, client: peer.client });
    expect(shared.sessions.find((row) => row.key === revoked.key)?.sharingRole).toBe("member");
    await listRows(projection, { limit: 200 });
    expire();
    expect(projection.capture({ agentId: "main", key: revoked.key })?.materialized).toBeUndefined();
    expect(removeSessionMember(scope, viewer.id)).not.toBeNull();
    const privateRows = await listRows(
      projection,
      { limit: 200 },
      { context, client: peer.client },
    );
    expect(privateRows.sessions.find((row) => row.key === revoked.key)?.sharingRole).toBe("viewer");
  }, true);
});
