import { expect, it, vi } from "vitest";
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

it("dedupes explicit work by type until the node drains it", () => {
  const first = enqueue("node-2");
  const second = enqueue("node-2");

  expect(second).toMatchObject({ deduped: true, item: { id: first.item.id } });

  drainNodePendingWork("node-2");

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
  expect(oldPairing.drain()).toMatchObject({ items: baseline });
  expect(oldPairing.clear()).toBe(false);
  expect(oldPairing.remove(retired.item.id)).toBe(false);
  expect(newPairing.drain()).toMatchObject({ items: [{ id: replacement.item.id }, ...baseline] });
});

it("expires queued work when a different pairing polls", () => {
  const work = pairing("node-retired-generation", "generation-1");
  work.enqueue({ expiresInMs: 1_000 });
  using _ = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
  pairing("node-retired-generation", "generation-2").drain();
  expect(work.clear()).toBe(false);
});

it("rolls back only the exact item owned by one enqueue", () => {
  const work = pairing("node-item-rollback", "generation-1");
  const location = work.enqueue();
  work.enqueue({ type: "status.request" });
  expect(work.remove(location.item.id)).toBe(true);
  expect(work.drain()).toMatchObject({ items: [{ type: "status.request" }] });
});

it.each([false, true])("pages deferred status work (explicit=%s)", (explicit) => {
  const nodeId = `paging-${explicit}`;
  if (explicit) {
    enqueue(nodeId, { type: "status.request", priority: "normal" });
  }
  enqueue(nodeId, { priority: "high" });
  expect(drainNodePendingWork(nodeId, { maxItems: 1 })).toMatchObject({
    items: [{ type: "location.request" }],
    hasMore: true,
  });
  expect(drainNodePendingWork(nodeId, { maxItems: 1 })).toMatchObject({
    items: explicit
      ? [{ type: "status.request", id: expect.not.stringMatching(/^baseline-status$/) }]
      : baseline,
    hasMore: false,
  });
});

it("assigns default expiry to queued work without explicit ttl", () => {
  using dateNow = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const expiresAtMs = 1_000 + 24 * 60 * 60_000;
  expect(enqueue("node-default-expiry").item.expiresAtMs).toBe(expiresAtMs);

  dateNow.mockReturnValue(expiresAtMs);
  expect(drainNodePendingWork("node-default-expiry")).toMatchObject({ items: baseline });
});
