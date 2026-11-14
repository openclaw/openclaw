import { expect, it, onTestFinished, vi } from "vitest";
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
  const capture = (id: number) => {
    const lease = claims.capture(
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
    onTestFinished(async () => {
      lease.receive({ type: "resource-closed", id, requestId: 0 });
      await lease.close().catch(() => {});
      lease.release();
    });
    return lease;
  };
  const closeRequest = () => {
    const close = transmit.mock.calls.find(([request]) => request.type === "resource-close")?.[0];
    if (!close || close.type !== "resource-close") {
      throw new Error("Expected the actual resource close request");
    }
    return close;
  };
  return { claims, capture, transmit, callbacks, closeRequest };
}

const capacityCases = [
  { dimension: "messages", payload: "", count: 4 },
  { dimension: "bytes", payload: "x".repeat(700), count: 1 },
];

it.each(capacityCases)(
  "reclaims outbound $dimension after repeated proven no-dispatch abandonment",
  ({ payload, count }) => {
    const { claims, capture, transmit } = fixture();
    for (let id = 1; id <= 3; id++) {
      const lease = capture(id);
      for (let message = 0; message < count; message++) {
        lease.ownerMessage(payload);
      }
      expect(() => lease.ownerMessage(payload)).toThrow(/delivery capacity exceeded/);
      expect(claims.size).toBe(1);
      // No attach/ready receipt and no transmission: this fixture owns no-dispatch proof.
      expect(transmit).not.toHaveBeenCalled();
      lease.abandonUnattached();
      expect(claims.size).toBe(0);
      expect(claims.hasOpenClaims).toBe(false);
    }
    expect(transmit).not.toHaveBeenCalled();
  },
);

it.each([
  ...capacityCases.map(({ dimension, payload, count }) => ({
    dimension,
    payload,
    count,
    source: "resource" as const,
  })),
  {
    source: "transport" as const,
    dimension: "messages",
    payload: "pending owner delivery",
    count: 1,
  },
])(
  "retains $source failure custody and pending $dimension until native close",
  async ({ source, payload, count }) => {
    const { claims, capture, transmit, callbacks } = fixture();
    const lease = capture(1);
    lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
    lease.receive({ type: "resource-created", id: 1 });
    for (let message = 0; message < count; message++) {
      lease.ownerMessage(payload);
    }
    const sibling = source === "resource" ? capture(2) : undefined;
    const failure = new Error(
      source === "resource" ? "resource operation failed" : "broker transport lost",
    );
    if (source === "resource") {
      await Promise.resolve();
      expect(transmit).toHaveBeenCalledTimes(count);
      lease.receive({
        type: "resource-failed",
        id: 1,
        error: encodeNativeWorkerFailure(failure),
      });
    } else {
      claims.fail(failure);
    }
    expect(callbacks.failed).toHaveBeenCalledOnce();
    const [reported] = callbacks.failed.mock.calls[0]!;
    expect(reported).toMatchObject({ message: failure.message });
    if (source === "transport") {
      expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith(failure);
      expect(reported).toBe(failure);
    }
    expect(claims.size).toBe(sibling ? 2 : 1);
    expect(claims.hasOpenClaims).toBe(true);
    expect(() => lease.release()).toThrow(/must close before release/);
    expect(() => lease.abandonUnattached()).toThrow(/cannot be abandoned/);
    if (sibling) {
      expect(() => sibling.ownerMessage(payload)).toThrow(/delivery capacity exceeded/);
    }
    lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
    expect(claims.hasOpenClaims).toBe(Boolean(sibling));
    lease.release();
    if (sibling) {
      sibling.ownerMessage(payload);
      sibling.abandonUnattached();
    }
    expect(claims.size).toBe(0);
  },
);

it("keeps pending cleanup when an earlier resource failure arrives through parent IPC", async () => {
  const { claims, capture, callbacks, closeRequest } = fixture();
  const lease = capture(1);
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  const closing = lease.close();
  const settled = vi.fn();
  void closing.then(settled, settled);
  await Promise.resolve();
  const close = closeRequest();
  const failure = new Error("original resource import failure");
  // The socket already observed this failure; parent IPC can arrive after close starts.
  lease.receive({ type: "resource-failed", id: 1, error: encodeNativeWorkerFailure(failure) });
  await Promise.resolve();
  expect(callbacks.failed).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ message: failure.message }),
  );
  expect(settled).not.toHaveBeenCalled();
  expect(claims.hasOpenClaims).toBe(true);
  expect(() => lease.release()).toThrow(/must close before release/);
  lease.receive({ type: "resource-closed", id: 1, requestId: close.requestId });
  await expect(closing).resolves.toBeUndefined();
  lease.release();
  expect(claims.size).toBe(0);
});

it("notifies every captured resource and retains callback failures in order", () => {
  const { claims, capture, callbacks } = fixture();
  capture(1);
  capture(2);
  const failure = new Error("transport lost");
  const failures = [new Error("first callback failed"), new Error("second callback failed")];
  for (const callbackError of failures) {
    callbacks.failed.mockImplementationOnce(() => {
      throw callbackError;
    });
  }
  try {
    claims.fail(failure);
    expect.unreachable("callback failures must be reported");
  } catch (error) {
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) {
      throw error;
    }
    expect(error.message).toBe("Native resource failure callback failed");
    expect(error.errors).toHaveLength(failures.length);
    failures.forEach((callbackError, index) => expect(error.errors[index]).toBe(callbackError));
  }
  expect(callbacks.failed.mock.calls).toEqual([[failure], [failure]]);
  expect(claims.hasOpenClaims).toBe(true);
  expect(() => claims.fail(failure)).not.toThrow();
  expect(callbacks.failed).toHaveBeenCalledTimes(2);
});

it("settles owner receipts independently and preserves rejection through cleanup and close", async () => {
  const { claims, capture, transmit, callbacks, closeRequest } = fixture();
  const lease = capture(1);
  const cause = Object.assign(new Error("original callback cause"), { code: "SQLITE_BUSY" });
  const failure = Object.assign(new Error("owner callback refused", { cause }), {
    code: "OWNER_CALLBACK_REFUSED",
  });
  const value = "x".repeat(700);
  const delivery = lease.ownerMessage(value);
  expect(transmit).not.toHaveBeenCalled();
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  lease.receive({ type: "resource-created", id: 1 });
  const receipt: BrokerResourceResponse = {
    type: "resource-owner-rejected",
    id: 1,
    sequence: delivery.sequence,
    error: encodeNativeWorkerFailure(failure),
  };
  await Promise.resolve();
  expect(transmit).toHaveBeenCalledExactlyOnceWith({
    type: "resource-owner",
    id: 1,
    sequence: delivery.sequence,
    value,
  });
  lease.receive(receipt);
  expect(callbacks.failed).toHaveBeenCalledOnce();
  const [reported] = callbacks.failed.mock.calls[0]!;
  expect(reported).toBeInstanceOf(Error);
  expect(reported).toMatchObject({
    message: "owner callback refused",
    code: "OWNER_CALLBACK_REFUSED",
    cause: { message: "original callback cause", code: "SQLITE_BUSY" },
  });
  expect(claims.hasOpenClaims).toBe(true);
  expect(claims.size).toBe(1);
  expect(() => lease.release()).toThrow(/must close before release/);
  lease.receive(receipt);
  expect(callbacks.failed).toHaveBeenCalledOnce();

  const cleanupValue = { command: "dispose", padding: "y".repeat(700) };
  const cleanup = lease.ownerMessage(cleanupValue);
  await Promise.resolve();
  expect(transmit).toHaveBeenLastCalledWith({
    type: "resource-owner",
    id: 1,
    sequence: cleanup.sequence,
    value: cleanupValue,
  });
  expect(() => lease.ownerMessage(cleanupValue)).toThrow(/delivery capacity exceeded/);
  lease.receive({ type: "resource-owner-received", id: 1, sequence: cleanup.sequence + 1 });
  await Promise.resolve();
  expect(() => lease.ownerMessage(cleanupValue)).toThrow(/delivery capacity exceeded/);
  lease.receive(receipt);
  await Promise.resolve();
  expect(() => lease.ownerMessage(cleanupValue)).toThrow(/delivery capacity exceeded/);
  expect(callbacks.failed).toHaveBeenCalledOnce();
  lease.receive({ type: "resource-owner-received", id: 1, sequence: cleanup.sequence });
  await Promise.resolve();
  expect(lease.ownerMessage(cleanupValue).sequence).toBe(cleanup.sequence + 1);
  expect(claims.hasOpenClaims).toBe(true);
  expect(claims.size).toBe(1);
  const closing = lease.close();
  await Promise.resolve();
  const close = closeRequest();
  lease.receive({ type: "resource-closed", id: 1, requestId: close.requestId });
  await closing;
  lease.release();
  expect(claims.size).toBe(0);
});

it("drops unsent owner delivery when native close precedes its acknowledgment", async () => {
  const { claims, capture, transmit } = fixture();
  const lease = capture(1);
  lease.ownerMessage("x".repeat(700));
  lease.receive({ type: "resource-ready", id: 1, pid: 42, generation: 1 });
  // Ready schedules the sender; native close arrives before that continuation can transmit.
  lease.receive({ type: "resource-closed", id: 1, requestId: 0 });
  await Promise.resolve();
  expect(transmit).not.toHaveBeenCalled();
  expect(claims.hasOpenClaims).toBe(false);
  expect(claims.size).toBe(1);
  await expect(lease.close()).resolves.toBeUndefined();
  expect(transmit).not.toHaveBeenCalled();

  // Closing frees packet credit even while the closed claim is awaiting release.
  const sibling = capture(2);
  sibling.ownerMessage("y".repeat(700));
  sibling.abandonUnattached();
  lease.release();
  expect(claims.size).toBe(0);
});
