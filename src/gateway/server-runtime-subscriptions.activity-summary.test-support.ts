import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";
import type { ActivitySummaryTarget } from "./session-activity-summary-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { withReadySessionRows } from "./session-row-prepared-read.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

type Start = (projection: SessionRowProjection) => {
  params: { broadcast: GatewayBroadcastFn };
  unsubs: { agentUnsub: () => Promise<void> };
};

export function registerActivitySummaryPublicationTests(
  start: Start,
  getOnChanged: () => ((target: ActivitySummaryTarget & { storePath: string }) => void) | undefined,
): void {
  it.each([false, true])(
    "publishes a ready activity-summary target during unrelated refresh (same-ID reset: %s)",
    async (reset) => {
      vi.useFakeTimers();
      const readStarted = createDeferred();
      const prepared = createDeferred();
      const unrelatedRefresh = createDeferred();
      let unrelatedDirty = true;
      const target = {
        key: "agent:main:activity",
        agentId: "main",
        storePath: "/tmp/activity-summary-tracked.sqlite",
      };
      const original = {
        key: target.key,
        agentId: target.agentId,
        storeTarget: { agentId: target.agentId, storePath: target.storePath },
        generation: Symbol("original"),
        entry: { sessionId: "same-session", lifecycleRevision: "original" },
      };
      let current = original;
      const projection = {
        capture: (query: unknown) => {
          expect(query).toEqual(target);
          return current;
        },
        ensureMaterialized: () => {
          readStarted.resolve();
          return unrelatedRefresh.promise;
        },
        get needsMaterialization() {
          return unrelatedDirty;
        },
        withPreparedExactRows: async (
          queries: Parameters<SessionRowProjection["withPreparedExactRows"]>[0],
          consume: () => void,
          options: Parameters<SessionRowProjection["withPreparedExactRows"]>[2],
        ) => {
          readStarted.resolve();
          expect(queries({})).toEqual([target]);
          expect(options).toEqual({ includeAncestors: true });
          await prepared.promise;
          return { kind: "complete", value: consume() };
        },
        isCurrent: (record: typeof original) => record === current,
        snapshot: (query: unknown) => {
          expect(query).toEqual(target);
          return { row: { key: target.key, ...current.entry } };
        },
      } as unknown as SessionRowProjection;
      let fixture: ReturnType<Start> | undefined;
      try {
        fixture = start(projection);
        const { params } = fixture;
        const onChanged = getOnChanged();
        if (!onChanged) {
          throw new Error("missing activity-summary publication callback");
        }
        onChanged(target);
        await readStarted.promise;
        expect(params.broadcast).not.toHaveBeenCalled();
        if (reset) {
          current = {
            ...original,
            generation: Symbol("replacement"),
            entry: { ...original.entry, lifecycleRevision: "replacement" },
          };
        }
        prepared.resolve();
        await vi.advanceTimersByTimeAsync(0);
        if (reset) {
          expect(params.broadcast).not.toHaveBeenCalled();
        } else {
          expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            expect.objectContaining({
              reason: "activity-summary",
              session: expect.objectContaining({ key: target.key, ...original.entry }),
            }),
            { sessionKeys: [target.key], agentId: target.agentId, dropIfSlow: true },
          );
        }
      } finally {
        prepared.resolve();
        unrelatedDirty = false;
        unrelatedRefresh.resolve();
        try {
          await fixture?.unsubs.agentUnsub();
        } finally {
          vi.useRealTimers();
        }
      }
      expect(fixture?.params.broadcast).toHaveBeenCalledTimes(reset ? 0 : 1);
    },
  );

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
        onChanged(target);
        await vi.advanceTimersByTimeAsync(0);
        expect(params.broadcast).toHaveBeenCalledExactlyOnceWith(
          "sessions.changed",
          expect.objectContaining({
            reason: "activity-summary",
            session: expect.objectContaining({ key: target.key, sessionId: "recap" }),
          }),
          { sessionKeys: [target.key], agentId: target.agentId, dropIfSlow: true },
        );
        expect(projection.needsMaterialization).toBe(true);
      } finally {
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
