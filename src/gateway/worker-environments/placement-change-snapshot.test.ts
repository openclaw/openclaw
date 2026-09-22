import { isMainThread } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  withDisposableOpenClawStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { flushPendingSessionsChangedEvents } from "../server-methods/session-change-event.js";
import { createGatewayWorkerPlacementChangePublisher } from "../server-worker-placement-change-events.js";
import type { WorkerSessionPlacementChangeSnapshot } from "./placement-record.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";

it.each(["cached", "fresh"] as const)(
  "reads detached %s placement snapshots off thread and joins the captured source",
  async (mode) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      expect(isMainThread).toBe(true);
      const database = openOpenClawStateDatabase();
      const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
      for (const sessionId of ["b", "a"]) {
        store.startDispatch({ sessionId, agentId: "main", sessionKey: `agent:main:${sessionId}` });
      }
      const failed = store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
      const warn = vi.fn();
      const publishChanges = createGatewayWorkerPlacementChangePublisher({
        placements: store,
        getSessionChangeContext: () => ({
          broadcastToConnIds: vi.fn(),
          chatAbortControllers: new Map(),
          getRuntimeConfig: () => ({}),
          getSessionEventSubscriberConnIds: () => new Set(),
        }),
        warn,
      });
      const expected: WorkerSessionPlacementChangeSnapshot[] = [
        {
          sessionId: "a",
          sessionKey: "agent:main:a",
          agentId: "main",
          state: "failed",
          generation: 2,
          updatedAtMs: 1000,
        },
        {
          sessionId: "b",
          sessionKey: "agent:main:b",
          agentId: "main",
          state: "requested",
          generation: 1,
          updatedAtMs: 1000,
        },
      ];
      if (mode === "fresh") {
        await closeOpenClawStateDatabaseAsync();
      }
      const { DatabaseSync, StatementSync } = requireNodeSqlite();
      const watchSql = () => [
        vi.spyOn(DatabaseSync.prototype, "prepare"),
        vi.spyOn(DatabaseSync.prototype, "exec"),
        ...(["get", "all", "run", "iterate"] as const).map((method) =>
          vi.spyOn(StatementSync.prototype, method),
        ),
      ];
      const calls = watchSql();
      let before: WorkerSessionPlacementChangeSnapshot[];
      try {
        before = await store.readChangeSnapshot();
        expect(before).toEqual(expected);
        await expect(publishChanges(async () => "reconciled")).resolves.toBe("reconciled");
        expect(warn).not.toHaveBeenCalled();
        expect(calls.reduce((count, call) => count + call.mock.calls.length, 0)).toBe(0);
        expect(database.db.isOpen).toBe(mode === "cached");
      } finally {
        vi.restoreAllMocks();
      }
      store.retireSessionPlacement({
        sessionId: "a",
        expectedState: "failed",
        expectedGeneration: failed.generation,
      });
      let after: unknown;
      const laterCalls = watchSql();
      try {
        await withDisposableOpenClawStateReads(database.path, async () => {
          void store.readChangeSnapshot().then(
            (rows) => {
              after = rows;
            },
            (error: unknown) => {
              after = error;
            },
          );
        });
        expect(after).toEqual([expected[1]]);
        expect(before).toEqual(expected);
        expect(laterCalls.reduce((count, call) => count + call.mock.calls.length, 0)).toBe(0);
      } finally {
        vi.restoreAllMocks();
      }
    });
  },
);

it("reports committed placement changes inside an inspection snapshot", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const database = openOpenClawStateDatabase();
    const store = createWorkerSessionPlacementStore({ database, now: () => 1000 });
    store.startDispatch({ sessionId: "a", agentId: "main", sessionKey: "agent:main:a" });
    const failed = store.fail({ sessionId: "a", recoveryError: "synthetic failure" });
    const broadcastToConnIds = vi.fn();
    const warn = vi.fn();
    const context = {
      broadcastToConnIds,
      chatAbortControllers: new Map(),
      getRuntimeConfig: () => ({}),
      getSessionEventSubscriberConnIds: () => new Set(["synthetic-client"]),
    };
    const publishChanges = createGatewayWorkerPlacementChangePublisher({
      placements: store,
      getSessionChangeContext: () => context,
      warn,
    });
    try {
      await withOpenClawStateDatabaseReadSnapshot(async () => {
        await expect(
          publishChanges(async () => {
            store.retireSessionPlacement({
              sessionId: "a",
              expectedState: "failed",
              expectedGeneration: failed.generation,
            });
            return "retired";
          }),
        ).resolves.toBe("retired");
        await flushPendingSessionsChangedEvents(context);
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "sessions.changed",
          expect.objectContaining({ reason: "placement", sessionKey: "agent:main:a" }),
          new Set(["synthetic-client"]),
          expect.any(Object),
        );
      });
      expect(store.list()).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await flushPendingSessionsChangedEvents(context);
    }
  });
});
