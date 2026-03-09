import { describe, expect, it, beforeEach } from "vitest";
import {
  acknowledgeNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  resetNodePendingWorkForTests,
} from "./node-pending-work.js";

describe("node pending work", () => {
  beforeEach(() => {
    resetNodePendingWorkForTests();
  });

  it("returns a baseline status request even when no explicit work is queued", () => {
    const drained = drainNodePendingWork("node-1");
    expect(drained.items).toEqual([
      expect.objectContaining({
        id: "baseline-status",
        type: "status.request",
        priority: "default",
      }),
    ]);
    expect(drained.hasMore).toBe(false);
  });

  it("dedupes explicit work by type and removes acknowledged items", () => {
    const first = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });
    const second = enqueueNodePendingWork({ nodeId: "node-2", type: "location.request" });

    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    const drained = drainNodePendingWork("node-2");
    expect(drained.items.map((item) => item.type)).toEqual(["location.request", "status.request"]);

    const acked = acknowledgeNodePendingWork({
      nodeId: "node-2",
      itemIds: [first.item.id, "baseline-status"],
    });
    expect(acked.removedItemIds).toEqual([first.item.id]);

    const afterAck = drainNodePendingWork("node-2");
    expect(afterAck.items.map((item) => item.id)).toEqual(["baseline-status"]);
  });
});
