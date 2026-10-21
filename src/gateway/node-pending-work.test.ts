import { describe, expect, it, vi } from "vitest";
import {
  clearNodePendingWork,
  drainNodePendingWork,
  enqueueNodePendingWork,
  removeNodePendingWorkItem,
} from "./node-pending-work.js";

function enqueue(
  nodeId: string,
  overrides: Partial<Parameters<typeof enqueueNodePendingWork>[0]> = {},
) {
  return enqueueNodePendingWork({ nodeId, type: "location.request", ...overrides });
}

function pairing(nodeId: string, pairingGeneration: string) {
  return {
    enqueue: (overrides: Parameters<typeof enqueue>[1] = {}) =>
      enqueue(nodeId, { pairingGeneration, ...overrides }),
    drain: (options: Parameters<typeof drainNodePendingWork>[1] = {}) =>
      drainNodePendingWork(nodeId, { pairingGeneration, ...options }),
    clear: () => clearNodePendingWork(nodeId, pairingGeneration),
    remove: (itemId: string) => removeNodePendingWorkItem({ nodeId, pairingGeneration, itemId }),
  };
}

const baseline = [{ id: "baseline-status" }];

describe("node pending work", () => {
  it("dedupes explicit work by type until the node drains it", () => {
    const first = enqueue("node-2");
    const second = enqueue("node-2");

    expect(first.deduped).toBe(false);
    expect(second).toMatchObject({ deduped: true, item: { id: first.item.id } });

    const drained = drainNodePendingWork("node-2");
    expect(drained).toMatchObject({
      items: [{ type: "location.request" }, { type: "status.request" }],
    });

    const afterDrain = enqueue("node-2");
    expect(afterDrain.deduped).toBe(false);
    expect(afterDrain.item.id).not.toBe(first.item.id);
    drainNodePendingWork("node-2");
  });

  it("clears explicit work when a pairing is removed", () => {
    enqueue("node-removed");

    expect(clearNodePendingWork(" node-removed ")).toBe(true);
    expect(drainNodePendingWork("node-removed")).toMatchObject({ items: baseline });
    expect(clearNodePendingWork("node-removed")).toBe(false);
  });

  it("keeps explicit work isolated from a replacement pairing generation", () => {
    const oldPairing = pairing("node-replaced", "generation-1");
    const newPairing = pairing("node-replaced", "generation-2");
    oldPairing.enqueue();
    expect(newPairing.drain()).toMatchObject({ items: baseline });
    expect(oldPairing.drain()).toMatchObject({
      items: [{ type: "location.request" }, { type: "status.request" }],
    });
    const retired = oldPairing.enqueue();
    const replacement = newPairing.enqueue();
    expect(oldPairing.drain({ includeDefaultStatus: false }).items).toEqual([]);
    expect(oldPairing.clear()).toBe(false);
    expect(oldPairing.remove(retired.item.id)).toBe(false);
    expect(newPairing.drain({ includeDefaultStatus: false })).toMatchObject({
      items: [{ id: replacement.item.id }],
    });
  });

  it("expires queued work when a different pairing polls", () => {
    enqueue("node-retired-generation", {
      expiresInMs: 1_000,
      pairingGeneration: "generation-1",
    });

    drainNodePendingWork("node-retired-generation", {
      pairingGeneration: "generation-2",
      nowMs: Date.now() + 2_000,
    });

    expect(clearNodePendingWork("node-retired-generation", "generation-1")).toBe(false);
  });

  it("rolls back only the exact item owned by one enqueue", () => {
    const work = pairing("node-item-rollback", "generation-1");
    const location = work.enqueue();
    work.enqueue({ type: "status.request" });
    expect(work.remove(location.item.id)).toBe(true);
    expect(work.drain({ includeDefaultStatus: false })).toMatchObject({
      items: [{ type: "status.request" }],
    });
  });

  it("keeps hasMore true when the baseline status item is deferred by maxItems", () => {
    enqueue("node-3");

    const drained = drainNodePendingWork("node-3", { maxItems: 1 });

    expect(drained).toMatchObject({ items: [{ type: "location.request" }], hasMore: true });

    const next = drainNodePendingWork("node-3", { maxItems: 1 });
    expect(next).toMatchObject({ items: baseline, hasMore: false });
  });

  it("keeps explicit work queued when maxItems defers it", () => {
    enqueue("node-4", { type: "status.request", priority: "normal" });
    enqueue("node-4", { priority: "high" });

    const firstDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(firstDrain).toMatchObject({ items: [{ type: "location.request" }], hasMore: true });

    const secondDrain = drainNodePendingWork("node-4", { maxItems: 1 });
    expect(secondDrain).toMatchObject({
      items: [{ type: "status.request", id: expect.not.stringMatching(/^baseline-status$/) }],
      hasMore: false,
    });
  });

  it("assigns default expiry to queued work without explicit ttl", () => {
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const expiresAtMs = 1_000 + 24 * 60 * 60_000;
    try {
      expect(enqueue("node-default-expiry").item.expiresAtMs).toBe(expiresAtMs);
    } finally {
      dateNow.mockRestore();
    }

    const drained = drainNodePendingWork("node-default-expiry", { nowMs: expiresAtMs });
    expect(drained).toMatchObject({ items: baseline });
  });
});
