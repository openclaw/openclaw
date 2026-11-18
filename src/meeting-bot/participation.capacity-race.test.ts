import { expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { MeetingParticipationAttempt } from "./participation-types.js";
import { MeetingParticipation } from "./participation.js";

it("admits both source claims when a sibling reclaimed their shared cleanup snapshot", async () => {
  const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
    await import("../plugin-state/plugin-state-store.js");
  await withOpenClawTestState({ label: "capacity-race", applyEnv: false }, async ({ env }) => {
    try {
      const real = createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", {
        namespace: "meeting-participation",
        maxEntries: 4,
        overflowPolicy: "reject-new",
        env,
      });
      for (const requestId of ["old-0", "old-1"]) {
        await real.register("closed:request:" + requestId, {
          kind: "meeting-participation-attempt",
          sessionId: "closed",
          requestId,
          fingerprint: "seed",
          actionType: "chat",
        });
      }
      const requestClaims = createDeferredCore();
      const snapshots = createDeferredCore();
      const firstCleanup = createDeferredCore();
      let registered = 0;
      let observed = 0;
      let removedRows = 0;
      const deleted: boolean[] = [];
      const store: typeof real = {
        ...real,
        registerIfAbsent: async (key, value) => {
          const inserted = await real.registerIfAbsent(key, value);
          if (key.startsWith("active:request:")) {
            if (++registered === 2) {
              requestClaims.resolve();
            }
            await requestClaims.promise;
          }
          return inserted;
        },
        entries: async () => {
          const entries = await real.entries();
          if (++observed === 2) {
            snapshots.resolve();
            // Return the second stale snapshot after the first sweep reclaims its rows.
            await firstCleanup.promise;
          }
          await snapshots.promise;
          return entries;
        },
        delete: async (key) => {
          const removed = await real.delete(key);
          deleted.push(removed);
          if (removed && ++removedRows === 2) {
            firstCleanup.resolve();
          }
          return removed;
        },
      };
      const executed: string[] = [];
      const owner = new MeetingParticipation({
        store,
        current: (id) => (id === "active" ? { session: {}, assertCurrent() {} } : undefined),
        capabilities: () => ["chat"],
        validateAction: () => undefined,
        execute: async (_session, request) => {
          executed.push(request.requestId);
          return { status: "succeeded" };
        },
      });
      owner.close("closed");
      const requests = (["A", "B"] as const).map((role) => {
        const sourceId = owner.observe("active", {
          id: "source-" + role,
          epoch: "page",
          revision: "1",
          kind: "caption",
          text: "Please reply to " + role,
          finalized: true,
        });
        expect(sourceId).toBeTruthy();
        return { requestId: role, sourceId, action: { type: "chat", text: role } };
      });
      const results = await Promise.all(
        requests.map((request) => owner.execute("active", request)),
      );
      expect(results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
      expect(deleted).toEqual([true, true, false, false]);
      expect(executed.toSorted()).toEqual(["A", "B"]);
      expect(await real.entries()).toHaveLength(4);
      expect(await real.lookup("closed:request:old-0")).toBeUndefined();
      expect(await real.lookup("active:request:B")).toMatchObject({
        result: { status: "succeeded" },
      });
      expect(await owner.execute("active", requests[1]!)).toMatchObject({
        status: "succeeded",
        replayed: true,
      });
      expect(executed).toHaveLength(2);
    } finally {
      resetPluginStateStoreForTests();
    }
  });
});
