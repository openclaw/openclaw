// Regression: idempotent continuation-return delivery
// retries can return the same durable delivery id that already backs the
// surviving queued system event. If the in-memory queue de-dupes the retry, do
// NOT ack or retire that id here or restart recovery loses the surviving queued event.
// Enqueue has no ack path at all; the refusal seam is the only way it settles a row.

import { describe, expect, it, vi } from "vitest";
import { enqueueContinuationReturnDeliveries } from "./targeting.js";

type ReturnDeliveryDeps = NonNullable<Parameters<typeof enqueueContinuationReturnDeliveries>[1]>;

function makeDeps(overrides: { enqueueSystemEvent: () => boolean }) {
  const enqueueSessionDelivery = vi.fn<ReturnDeliveryDeps["enqueueSessionDelivery"]>(
    async () => "delivery-id-1",
  );
  const refuseSessionDelivery = vi.fn<NonNullable<ReturnDeliveryDeps["refuseSessionDelivery"]>>(
    async () => {},
  );
  const enqueueSystemEvent = vi.fn<ReturnDeliveryDeps["enqueueSystemEvent"]>(() =>
    overrides.enqueueSystemEvent(),
  );
  const requestContinuationWake = vi.fn<ReturnDeliveryDeps["requestContinuationWake"]>();
  return {
    enqueueSessionDelivery,
    refuseSessionDelivery,
    enqueueSystemEvent,
    requestContinuationWake,
  };
}

describe("enqueueContinuationReturnDeliveries :: de-duplicated ack reconciliation", () => {
  it("does not ack an idempotent durable delivery row when the in-memory enqueue de-dupes it", async () => {
    const deps = makeDeps({ enqueueSystemEvent: () => false });

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:root"],
        text: "identical return text",
        idempotencyKeyBase: "idem-base",
        stateDir: "/tmp/state",
        ownerAgentId: "main",
      },
      deps,
    );

    expect(deps.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(deps.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // The existing queued event carries the ack id; retiring it here would delete
    // the restart-recovery backing row before prompt drain consumes it.
    expect(deps.refuseSessionDelivery).not.toHaveBeenCalled();
    // The content still counts as delivered via the surviving duplicate.
    expect(result.enqueued).toBe(1);
  });

  it("does not ack when the system-event enqueue succeeds (durable row rides the queued event)", async () => {
    const deps = makeDeps({ enqueueSystemEvent: () => true });

    await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:root"],
        text: "fresh return text",
        idempotencyKeyBase: "idem-base",
        stateDir: "/tmp/state",
        ownerAgentId: "main",
      },
      deps,
    );

    expect(deps.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // Queued event carries the ack id; the prompt-drain path acks it later.
    expect(deps.refuseSessionDelivery).not.toHaveBeenCalled();
  });
});
