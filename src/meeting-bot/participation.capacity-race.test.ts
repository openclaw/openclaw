import { AsyncLocalStorage } from "node:async_hooks";
import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  MeetingParticipationAttempt,
  MeetingParticipationOptions,
} from "./participation-types.js";
import { MeetingParticipation } from "./participation.js";

describe("meeting participation concurrent capacity recovery", () => {
  it("admits both source claims when a sibling reclaimed their shared cleanup snapshot", async () => {
    const { withOpenClawTestState } = await import("../test-utils/openclaw-test-state.js");
    const { createPluginStateKeyedStore, resetPluginStateStoreForTests } =
      await import("../plugin-state/plugin-state-store.js");
    await withOpenClawTestState(
      { label: "participation-cleanup-race", applyEnv: false },
      async (state) => {
        try {
          const real = createPluginStateKeyedStore<MeetingParticipationAttempt>("google-meet", {
            namespace: "meeting-participation",
            maxEntries: 4,
            overflowPolicy: "reject-new",
            env: state.env,
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
          const roles = new AsyncLocalStorage<"A" | "B">();
          const requestClaims = createDeferredCore();
          const snapshots = createDeferredCore();
          const firstCleanup = createDeferredCore();
          let registered = 0;
          let observed = 0;
          let removedByA = 0;
          const deleted: Array<{ role: "A" | "B" | undefined; removed: boolean }> = [];
          const store: MeetingParticipationOptions<object>["store"] = {
            lookup: (key) => real.lookup(key),
            register: (key, value) => real.register(key, value),
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
              }
              await snapshots.promise;
              return entries;
            },
            delete: async (key) => {
              const role = roles.getStore();
              if (role === "B") {
                await firstCleanup.promise;
              }
              const removed = await real.delete(key);
              deleted.push({ role, removed });
              if (role === "A" && removed && ++removedByA === 2) {
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
              ownEcho: false,
            });
            if (!sourceId) {
              throw new Error("Expected a current source");
            }
            return { requestId: role, sourceId, action: { type: "chat", text: role } };
          });
          const results = await Promise.all([
            roles.run("A", () => owner.execute("active", requests[0]!)),
            roles.run("B", () => owner.execute("active", requests[1]!)),
          ]);
          expect(results.map((result) => result.status)).toEqual(["succeeded", "succeeded"]);
          expect(
            deleted.filter((entry) => entry.role === "B").map((entry) => entry.removed),
          ).toEqual([false, false]);
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
      },
    );
  });
});
