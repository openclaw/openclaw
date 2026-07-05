/**
 * Node pending-work tracking tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
<<<<<<< HEAD
=======
  acknowledgeNodePendingWork,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  drainNodePendingWork,
  enqueueNodePendingWork,
  getNodePendingWorkStateCountForTests,
  resetNodePendingWorkForTests,
} from "./node-pending-work.js";

describe("node pending work", () => {
  beforeEach(() => {
    resetNodePendingWorkForTests();
  });

  it("returns a baseline status request even when no explicit work is queued", () => {
    const drained = drainNodePendingWork("node-1");
    expect(drained.items).toHaveLength(1);
    expect(drained.items[0]?.id).toBe("baseline-status");
    expect(drained.items[0]?.type).toBe("status.request");
    expect(drained.items[0]?.priority).toBe("default");
    expect(typeof drained.items[0]?.createdAtMs).toBe("number");
    expect(drained.items[0]?.expiresAtMs).toBeNull();
    expect(drained.hasMore).toBe(false);
  });

<<<<<<< HEAD
  it("dedupes explicit work by type until the node drains it", () => {
=======
  it("dedupes explicit work by type and removes acknowledged items", () => {
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    const first = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });
    const second = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    const drained = drainNodePendingWork("node-2");
    expect(drained.items.map((item) => item.type)).toEqual(["location.request", "status.request"]);
<<<<<<< HEAD
    expect(getNodePendingWorkStateCountForTests()).toBe(0);

    const afterDrain = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });
    expect(afterDrain.deduped).toBe(false);
    expect(afterDrain.item.id).not.toBe(first.item.id);
=======

    const acked = acknowledgeNodePendingWork({
      nodeId: "node-2",
      itemIds: [first.item.id, "baseline-status"],
    });
    expect(acked.removedItemIds).toEqual([first.item.id]);

    const afterAck = drainNodePendingWork("node-2");
    expect(afterAck.items.map((item) => item.id)).toEqual(["baseline-status"]);
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("keeps hasMore true when the baseline status item is deferred by maxItems", () => {
    enqueueNodePendingWork({ nodeId: "node-3", type: "location.request" });

    const drained = drainNodePendingWork("node-3", { maxItems: 1 });

    expect(drained.items.map((item) => item.type)).toEqual(["location.request"]);
    expect(drained.hasMore).toBe(true);
<<<<<<< HEAD
    expect(getNodePendingWorkStateCountForTests()).toBe(0);

    const next = drainNodePendingWork("node-3", { maxItems: 1 });
    expect(next.items.map((item) => item.id)).toEqual(["baseline-status"]);
    expect(next.hasMore).toBe(false);
  });

  it("keeps explicit work queued when maxItems defers it", () => {
    enqueueNodePendingWork({ nodeId: "node-4", type: "status.request", priority: "normal" });
    enqueueNodePendingWork({ nodeId: "node-4", type: "location.request", priority: "high" });

    const firstDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(firstDrain.items.map((item) => item.type)).toEqual(["location.request"]);
    expect(firstDrain.hasMore).toBe(true);
    expect(getNodePendingWorkStateCountForTests()).toBe(1);

    const secondDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(secondDrain.items.map((item) => item.type)).toEqual(["status.request"]);
    expect(secondDrain.items.map((item) => item.id)).not.toEqual(["baseline-status"]);
    expect(secondDrain.hasMore).toBe(false);
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  it("does not allocate state for drain-only nodes with no queued work", () => {
    expect(getNodePendingWorkStateCountForTests()).toBe(0);

<<<<<<< HEAD
    const drained = drainNodePendingWork("node-5");

    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("assigns default expiry to queued work without explicit ttl", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const expiresAtMs = (() => {
      try {
        const { item } = enqueueNodePendingWork({
          nodeId: "node-default-expiry",
          type: "location.request",
        });
        const queuedExpiresAtMs = item.expiresAtMs;
        expect(queuedExpiresAtMs).toBe(1_000 + 24 * 60 * 60_000);
        if (typeof queuedExpiresAtMs !== "number") {
          throw new Error("expected queued work expiry");
        }
        return queuedExpiresAtMs;
      } finally {
        dateNow.mockRestore();
      }
    })();

    const drained = drainNodePendingWork("node-default-expiry", { nowMs: expiresAtMs });

    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
=======
    const drained = drainNodePendingWork("node-4");
    const acked = acknowledgeNodePendingWork({ nodeId: "node-4", itemIds: ["baseline-status"] });

    expect(drained.items.map((item) => item.id)).toEqual(["baseline-status"]);
    expect(acked).toEqual({ revision: 0, removedItemIds: [] });
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("prunes the state entry once all explicit items are acknowledged", () => {
    const { item } = enqueueNodePendingWork({ nodeId: "node-5", type: "status.request" });
    expect(getNodePendingWorkStateCountForTests()).toBe(1);

    acknowledgeNodePendingWork({ nodeId: "node-5", itemIds: [item.id] });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("prunes the state entry when all items expire naturally via drain", () => {
    const queued = enqueueNodePendingWork({
<<<<<<< HEAD
      nodeId: "node-7",
=======
      nodeId: "node-6",
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      type: "location.request",
      expiresInMs: 5_000,
    });
    expect(getNodePendingWorkStateCountForTests()).toBe(1);

<<<<<<< HEAD
    const drained = drainNodePendingWork("node-7", { nowMs: Date.now() + 60_000 });
=======
    const drained = drainNodePendingWork("node-6", { nowMs: Date.now() + 60_000 });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    expect(drained.revision).toBeGreaterThan(queued.revision);
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("expires timed pending work immediately when the enqueue clock is invalid", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(Number.NaN);
    try {
      const { item } = enqueueNodePendingWork({
        nodeId: "node-7",
        type: "location.request",
        expiresInMs: 5_000,
      });
      expect(item.createdAtMs).toBe(0);
      expect(item.expiresAtMs).toBe(0);
    } finally {
      dateNow.mockRestore();
    }

    drainNodePendingWork("node-7", { nowMs: 1_000 });
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });

  it("expires timed pending work immediately when expiry would exceed Date bounds", () => {
    const { item } = enqueueNodePendingWork({
      nodeId: "node-8",
      type: "location.request",
      expiresInMs: Number.MAX_SAFE_INTEGER,
    });
    expect(item.expiresAtMs).toBe(0);

    drainNodePendingWork("node-8", { nowMs: Date.now() });
    expect(getNodePendingWorkStateCountForTests()).toBe(0);
  });
});
