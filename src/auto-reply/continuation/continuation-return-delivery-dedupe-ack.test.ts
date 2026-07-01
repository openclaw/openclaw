// P2 (web-Codex r3502790187) regression: when the in-memory system-event queue
// collapses a continuation-return delivery as a duplicate before the ack id can
// ride out on a queued event, the durable delivery row would otherwise never be
// acked and restart recovery would replay it as a duplicate return. The dropped
// duplicate's durable row must be acked at enqueue time instead.

import { describe, expect, it, vi } from "vitest";
import { enqueueContinuationReturnDeliveries } from "./targeting.js";

function makeDeps(overrides: { enqueueSystemEvent: () => boolean }) {
  const enqueueSessionDelivery = vi.fn(async () => "delivery-id-1");
  const ackSessionDelivery = vi.fn(async () => undefined);
  const enqueueSystemEvent = vi.fn(overrides.enqueueSystemEvent);
  const requestHeartbeatNow = vi.fn();
  return {
    enqueueSessionDelivery,
    ackSessionDelivery,
    enqueueSystemEvent,
    requestHeartbeatNow,
  };
}

describe("enqueueContinuationReturnDeliveries :: de-duplicated ack reconciliation", () => {
  it("acks the durable delivery row when the system-event enqueue is de-duplicated", async () => {
    const deps = makeDeps({ enqueueSystemEvent: () => false });

    const result = await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:root"],
        text: "identical return text",
        idempotencyKeyBase: "idem-base",
        stateDir: "/tmp/state",
      },
      deps,
    );

    expect(deps.enqueueSessionDelivery).toHaveBeenCalledTimes(1);
    expect(deps.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // The dropped duplicate's durable row is reconciled immediately.
    expect(deps.ackSessionDelivery).toHaveBeenCalledTimes(1);
    expect(deps.ackSessionDelivery).toHaveBeenCalledWith("delivery-id-1", "/tmp/state");
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
      },
      deps,
    );

    expect(deps.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    // Queued event carries the ack id; the prompt-drain path acks it later.
    expect(deps.ackSessionDelivery).not.toHaveBeenCalled();
  });
});
