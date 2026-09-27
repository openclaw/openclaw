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
