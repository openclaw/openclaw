import { expect, it, vi } from "vitest";
import { encodeNativeWorkerFailure } from "../../infra/worker-native-error.js";
import { BrokerResourceClaims } from "./resource-host.js";
import type { BrokerResourceRequest, BrokerResourceResponse } from "./resource-protocol.js";

// Exercise both capacity dimensions without reserving the production 256 MiB budget.
vi.mock("./ipc.js", () => ({ MAX_PENDING_BYTES: 1024, MAX_PENDING_MESSAGES: 4 }));

function fixture() {
  const transmit = vi
    .fn<(request: Exclude<BrokerResourceRequest, { type: "resource-attach" }>) => Promise<void>>()
    .mockResolvedValue();
  const callbacks = {
    message: vi.fn<(response: BrokerResourceResponse) => void>(),
    failed: vi.fn<(error: Error) => void>(),
  };
  const claims = new BrokerResourceClaims({
    transmit,
    markReady: vi.fn(),
    refreshReference: vi.fn(),
  });
  const capture = (id: number) =>
    claims.capture(
      {
        id,
        endpoint: "synthetic-resource-endpoint",
        secret: "synthetic-resource-secret",
        generation: 1,
        moduleUrl: "file:///synthetic/resource.mjs",
        ownerPort: true,
      },
      callbacks,
    );
  return { claims, capture, transmit, callbacks };
}

const capacityCases = [
  { dimension: "messages", payload: "", count: 4 },
  { dimension: "bytes", payload: "x".repeat(700), count: 1 },
];

it.each(capacityCases)(
  "reclaims outbound $dimension after repeated proven no-dispatch abandonment",
  async ({ payload, count }) => {
    const { claims, capture, transmit } = fixture();
    for (let id = 1; id <= 3; id++) {
      const lease = capture(id);
      const deliveries: Array<ReturnType<typeof lease.ownerMessage>> = [];
      try {
        for (let message = 0; message < count; message++) {
          deliveries.push(lease.ownerMessage(payload));
        }
        expect(() => lease.ownerMessage(payload)).toThrow(/delivery capacity exceeded/);
        expect(claims.size).toBe(1);
        // No attach/ready receipt and no transmission: this fixture owns no-dispatch proof.
        expect(transmit).not.toHaveBeenCalled();
      } finally {
        lease.abandonUnattached();
      }
      expect(claims.size).toBe(0);
      expect(claims.hasOpenClaims).toBe(false);
      for (const delivery of deliveries) {
        await expect(delivery.result).rejects.toThrow(/never dispatched/);
      }
    }
    expect(transmit).not.toHaveBeenCalled();
  },
);

it.each(capacityCases)(
  "keeps outbound $dimension charged while a failed resource has unknown native custody",
  async ({ payload, count }) => {
    const { claims, capture, transmit, callbacks } = fixture();
    const lease = capture(1);
    lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
    lease.receive({ type: "resource-created", id: 1 });
    const deliveries = Array.from({ length: count }, () => lease.ownerMessage(payload));
    const sibling = capture(2);
    try {
      await Promise.resolve();
      expect(transmit).toHaveBeenCalledTimes(count);
      lease.receive({
        type: "resource-failed",
        id: 1,
        error: encodeNativeWorkerFailure(new Error("resource operation failed")),
      });
      expect(callbacks.failed).toHaveBeenCalledOnce();
      const [reported] = callbacks.failed.mock.calls[0]!;
      expect(reported).toMatchObject({ message: "resource operation failed" });
      for (const delivery of deliveries) {
        await expect(delivery.result).rejects.toBe(reported);
      }
      expect(claims.size).toBe(2);
      expect(claims.hasOpenClaims).toBe(true);
      expect(() => lease.release()).toThrow(/must close before release/);
      expect(() => lease.abandonUnattached()).toThrow(/cannot be abandoned/);
      expect(() => sibling.ownerMessage(payload)).toThrow(/delivery capacity exceeded/);
      lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
      for (const delivery of deliveries) {
        await expect(delivery.result).rejects.toBe(reported);
      }
      lease.release();
      const next = sibling.ownerMessage(payload);
      sibling.abandonUnattached();
      await expect(next.result).rejects.toThrow(/never dispatched/);
      expect(claims.size).toBe(0);
    } finally {
      lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
      lease.release();
      sibling.abandonUnattached();
      await Promise.allSettled(deliveries.map((delivery) => delivery.result));
    }
  },
);

it("retains failed source claims until a native close receipt releases their custody", async () => {
  const { claims, capture, callbacks } = fixture();
  const lease = capture(1);
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  lease.receive({ type: "resource-created", id: 1 });
  const delivery = lease.ownerMessage("pending owner delivery");
  const failure = new Error("broker transport lost");
  claims.fail(failure);
  await expect(delivery.result).rejects.toBe(failure);
  expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith(failure);
  expect(claims.size).toBe(1);
  expect(claims.hasOpenClaims).toBe(true);
  expect(() => lease.release()).toThrow(/must close before release/);
  expect(() => lease.abandonUnattached()).toThrow(/cannot be abandoned/);
  lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
  expect(claims.hasOpenClaims).toBe(false);
  lease.release();
  expect(claims.size).toBe(0);
});

it("settles actual owner delivery on its receipt before resource close", async () => {
  const { claims, capture, transmit } = fixture();
  const lease = capture(1);
  const value = { command: "observe" };
  const delivery = lease.ownerMessage(value);
  let delivered = false;
  void delivery.result.then(() => {
    delivered = true;
  });
  expect(transmit).not.toHaveBeenCalled();
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  lease.receive({ type: "resource-created", id: 1 });
  try {
    await Promise.resolve();
    expect(transmit).toHaveBeenCalledExactlyOnceWith({
      type: "resource-owner",
      id: 1,
      sequence: delivery.sequence,
      value,
    });
    expect(delivered).toBe(false);
    lease.receive({ type: "resource-owner-received", id: 1, sequence: delivery.sequence + 1 });
    await Promise.resolve();
    expect(delivered).toBe(false);
    lease.receive({ type: "resource-owner-received", id: 1, sequence: delivery.sequence });
    await Promise.resolve();
    expect(delivered).toBe(true);
    await delivery.result;
    expect(claims.hasOpenClaims).toBe(true);
    expect(claims.size).toBe(1);
    const closing = lease.close();
    await Promise.resolve();
    const close = transmit.mock.calls
      .map(([request]) => request)
      .find((request) => request.type === "resource-close");
    expect(close).toBeDefined();
    if (!close || close.type !== "resource-close") {
      throw new Error("Expected the actual resource close request");
    }
    lease.receive({ type: "resource-closed", id: 1, requestId: close.requestId });
    await closing;
  } finally {
    lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
    lease.release();
  }
  expect(claims.size).toBe(0);
});

it("preserves a rejected owner receipt while allowing a later cleanup delivery", async () => {
  const { claims, capture, transmit, callbacks } = fixture();
  const lease = capture(1);
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  lease.receive({ type: "resource-created", id: 1 });
  const cause = Object.assign(new Error("original callback cause"), { code: "SQLITE_BUSY" });
  const failure = Object.assign(new Error("owner callback refused", { cause }), {
    code: "OWNER_CALLBACK_REFUSED",
  });
  const delivery = lease.ownerMessage("x".repeat(700));
  const receipt: BrokerResourceResponse = {
    type: "resource-owner-rejected",
    id: 1,
    sequence: delivery.sequence,
    error: encodeNativeWorkerFailure(failure),
  };
  try {
    await Promise.resolve();
    expect(transmit).toHaveBeenCalledTimes(1);
    lease.receive(receipt);
    expect(callbacks.failed).toHaveBeenCalledOnce();
    const [reported] = callbacks.failed.mock.calls[0]!;
    expect(reported).toBeInstanceOf(Error);
    expect(reported).toMatchObject({
      message: "owner callback refused",
      code: "OWNER_CALLBACK_REFUSED",
      cause: { message: "original callback cause", code: "SQLITE_BUSY" },
    });
    await expect(delivery.result).rejects.toBe(reported);
    expect(claims.hasOpenClaims).toBe(true);
    expect(claims.size).toBe(1);
    expect(() => lease.release()).toThrow(/must close before release/);
    lease.receive(receipt);
    expect(callbacks.failed).toHaveBeenCalledOnce();
    await expect(delivery.result).rejects.toBe(reported);

    const cleanupValue = { command: "dispose", padding: "y".repeat(700) };
    const cleanup = lease.ownerMessage(cleanupValue);
    let cleanupDelivered = false;
    void cleanup.result.then(() => {
      cleanupDelivered = true;
    });
    await Promise.resolve();
    expect(transmit).toHaveBeenLastCalledWith({
      type: "resource-owner",
      id: 1,
      sequence: cleanup.sequence,
      value: cleanupValue,
    });
    lease.receive(receipt);
    await Promise.resolve();
    expect(cleanupDelivered).toBe(false);
    expect(callbacks.failed).toHaveBeenCalledOnce();
    lease.receive({ type: "resource-owner-received", id: 1, sequence: cleanup.sequence });
    await Promise.resolve();
    expect(cleanupDelivered).toBe(true);
    await cleanup.result;
    expect(claims.hasOpenClaims).toBe(true);
    await expect(delivery.result).rejects.toBe(reported);
  } finally {
    lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
    lease.release();
  }
  expect(claims.size).toBe(0);
});

it("rejects unsent owner delivery when native close precedes its acknowledgment", async () => {
  const { claims, capture, transmit } = fixture();
  const lease = capture(1);
  const delivery = lease.ownerMessage("x".repeat(700));
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  // Ready schedules the sender; native close arrives before that continuation can transmit.
  lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
  try {
    await expect(delivery.result).rejects.toThrow(/closed before owner delivery was acknowledged/);
    expect(transmit).not.toHaveBeenCalled();
    expect(claims.hasOpenClaims).toBe(false);
    expect(claims.size).toBe(1);
    await expect(lease.close()).resolves.toBeUndefined();
    expect(transmit).not.toHaveBeenCalled();

    // Closing frees packet credit even while the closed claim is awaiting release.
    const sibling = capture(2);
    try {
      const next = sibling.ownerMessage("y".repeat(700));
      sibling.abandonUnattached();
      await expect(next.result).rejects.toThrow(/never dispatched/);
    } finally {
      sibling.abandonUnattached();
    }
  } finally {
    lease.release();
  }
  expect(claims.size).toBe(0);
});
