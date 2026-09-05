// Regression test for issue #137214: a restart-recovery tombstone failure at
// the head of an ordered ingress lane must dead-letter immediately so the
// queued reset command behind it can reach lifecycle admission.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createChannelIngressDrain } from "./ingress-drain.js";
import {
  createTestIngressQueue,
  type IngressDrainTestPayload as Payload,
  withTempState,
} from "./ingress-drain.test-helpers.js";

// Module-private in ingress-drain.ts; derive from the factory signature.
type ChannelIngressDispatchLifecycle = Parameters<
  Parameters<typeof createChannelIngressDrain>[0]["dispatchClaimedEvent"]
>[1];

describe("channel ingress drain restart-recovery tombstone", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("dead-letters a tombstoned lane head so the queued reset command can dispatch", async () => {
    await withTempState(async (stateDir) => {
      const queue = createTestIngressQueue(stateDir, { now: () => 10_000 });
      await queue.enqueue("evt-head", { text: "question" }, { laneKey: "dm", receivedAt: 1 });
      await queue.enqueue("evt-new", { text: "/new" }, { laneKey: "dm", receivedAt: 2 });
      const lifecycles = new Map<string, ChannelIngressDispatchLifecycle>();
      const drain = createChannelIngressDrain<Payload>({
        queue,
        now: () => 10_000,
        deferredLaneOccupancy: "release",
        dispatchClaimedEvent: async (event, lifecycle) => {
          lifecycles.set(event.id, lifecycle);
          return { kind: "deferred" };
        },
      });

      // Strict lane order: only the head is claimed first.
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(lifecycles.size).toBe(1));
      expect(lifecycles.has("evt-head")).toBe(true);
      await expectDefined(
        expectDefined(lifecycles.get("evt-head"), "head lifecycle").onFailed,
        "head failure lifecycle",
      )(
        Object.assign(
          new Error(
            'Session "agent:main:main" ended during restart recovery. Use /new or /reset to start a replacement session.',
          ),
          { code: "SESSION_RESTART_RECOVERY_TOMBSTONE" },
        ),
      );

      // The tombstoned head is dead-lettered without waiting for the retry
      // age gate, freeing the lane for the reset command behind it.
      expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
        { id: "evt-head", reason: "restart-recovery-tombstone" },
      ]);
      expect(await drain.drainOnce()).toEqual({ started: 1 });
      await vi.waitFor(() => expect(lifecycles.size).toBe(2));
      expect(lifecycles.has("evt-new")).toBe(true);
      drain.dispose();
    });
  });
});
