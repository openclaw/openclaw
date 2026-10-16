import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { GatewayConnectionWork } from "./server-connection-work.js";
import type { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { ActivitySummaryTarget } from "./session-activity-summary-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

type Start = (
  projection: SessionRowProjection,
  signal?: AbortSignal,
) => {
  params: Pick<
    Parameters<typeof startGatewayEventSubscriptions>[0],
    "broadcast" | "scheduler" | "sessionEventSubscribers"
  >;
  unsubs: { agentUnsub: () => Promise<void> };
};

export function registerActivitySummaryPublicationTests(
  start: Start,
  getOnChanged: () => ((target: ActivitySummaryTarget & { storePath: string }) => void) | undefined,
): void {
  it("delivers a coalesced recap after producer closure and joins it during shutdown", async () => {
    vi.useFakeTimers();
    const target = { key: "agent:main:recap", agentId: "main", storePath: "/recap/agent.sqlite" };
    const entry = { sessionId: "recap", lifecycleRevision: "original", updatedAt: 1 };
    const projection = createSessionRowProjectionFixture({
      cfg: { agents: { entries: { main: {} } } },
      store: { [target.key]: entry },
      storePath: target.storePath,
    });
    const producer = new AsyncWorkScope();
    const connectionWork = new GatewayConnectionWork();
    const { params, unsubs } = start(projection, connectionWork.signal);
    const subscribed = makeClient("activity", "operator", ["operator.read"]);
    const other = makeClient("unsubscribed", "operator", ["operator.read"]);
    params.sessionEventSubscribers.subscribe(subscribed.client.connId);
    const broadcaster = createGatewayBroadcaster({
      clients: new GatewayClientRegistry([subscribed.client, other.client]),
      canReceiveSessionEvent: (client) =>
        params.sessionEventSubscribers.getAll().has(client.connId),
    });
    vi.mocked(params.broadcast).mockImplementation(broadcaster.broadcast);
    const entered = createDeferred();
    const release = createDeferred();
    const prepare = projection.withPreparedExactRows.bind(projection);
    vi.spyOn(projection, "withPreparedExactRows").mockImplementation(async (...args) => {
      entered.resolve();
      await release.promise;
      return prepare(...args);
    });
    let closing: Promise<void> | undefined;
    try {
      const onChanged = getOnChanged()!;
      producer.run(() => onChanged(target));
      await entered.promise;
      projection.setEntry(target.key, { ...entry, label: "latest recap row" });
      producer.run(() => onChanged(target));
      await producer.drain();
      // server-lifecycle closes scheduler admission before connection work;
      // server-close then joins subscriptions before sockets and projection.
      params.scheduler.beginClose();
      connectionWork.beginClose();
      let closed = false;
      closing = unsubs.agentUnsub().then(() => {
        closed = true;
      });
      onChanged(target);
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
      expect(subscribed.socket.send).not.toHaveBeenCalled();
      release.resolve();
      await vi.runAllTimersAsync();
      await closing;
      expect(subscribed.socket.send).toHaveBeenCalledOnce();
      expect(JSON.parse(subscribed.socket.send.mock.calls[0]![0])).toMatchObject({
        event: "sessions.changed",
        payload: {
          reason: "activity-summary",
          session: { key: target.key, sessionId: entry.sessionId, label: "latest recap row" },
        },
      });
      onChanged(target);
      await vi.runAllTimersAsync();
      expect(subscribed.socket.send).toHaveBeenCalledOnce();
      expect(other.socket.send).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await vi.runAllTimersAsync();
      await (closing ?? unsubs.agentUnsub());
      await params.scheduler.stop();
      await connectionWork.drain();
      projection.dispose();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("publishes a prepared recap while the real projection retains an unrelated dirty row", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      const target = {
        key: "agent:main:recap",
        agentId: "main",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const parent = { ...target, key: "agent:main:recap-parent" };
      for (const [key, sessionId, parentSessionKey, archivedAt] of [
        [parent.key, "recap-parent", undefined, 1],
        [target.key, "recap", parent.key, undefined],
        ["agent:main:unrelated", "unrelated", undefined, undefined],
      ] as const) {
        replaceSessionEntrySync(
          { agentId: "main", sessionKey: key },
          { sessionId, updatedAt: 1, parentSessionKey, archivedAt },
        );
      }
      const placements = createWorkerSessionPlacementStore();
      const releaseForeground = retainSessionListForegroundWork();
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [],
        placementFactsReader: placements,
      }).catch((error: unknown) => {
        releaseForeground();
        throw error;
      });
      const entered = createDeferred();
      const release = createDeferred();
      let unsubs: ReturnType<Start>["unsubs"] | undefined;
      let sql: ReturnType<typeof observeHostDataSql> | undefined;
      try {
        const started = start(projection);
        const { params } = started;
        unsubs = started.unsubs;
        await projection.ensureMaterialized();
        const read = placements.readProjection.bind(placements);
        vi.spyOn(placements, "readProjection").mockImplementation(async (ids) => {
          const snapshot = await read(ids);
          if (ids.includes("unrelated")) {
            entered.resolve();
            await release.promise;
          }
          return snapshot;
        });
        sessionChanges.emit({ all: true, scope: "worker-placements" });
        await entered.promise;
        await withReadySessionRows(
          projection,
          () => [target],
          () => undefined,
          {
            includeAncestors: true,
          },
        );
        const row = projection.describe(target)!;
        expect(projection.ancestorRows(row)?.map((ancestor) => ancestor.key)).toEqual([parent.key]);
        expect(projection.needsMaterialization).toBe(true);
        const onChanged = getOnChanged();
        if (!onChanged) {
          throw new Error("missing activity-summary publication callback");
        }
        vi.useFakeTimers();
        sql = observeHostDataSql();
        onChanged(target);
        await vi.advanceTimersByTimeAsync(0);
        expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "activity-summary",
            session: expect.objectContaining({ key: target.key, sessionId: "recap" }),
          }),
          {
            sessionKeys: [target.key],
            agentId: target.agentId,
            dropIfSlow: true,
            prepareSessionProjection: expect.any(Function),
          },
        );
        expect(projection.needsMaterialization).toBe(true);
        expect(sql.queries).toEqual([]);
      } finally {
        sql?.restore();
        vi.useRealTimers();
        release.resolve();
        try {
          await unsubs?.agentUnsub();
          await projection.ensureMaterialized();
        } finally {
          try {
            projection.dispose();
          } finally {
            releaseForeground();
          }
        }
      }
    });
  });
}
