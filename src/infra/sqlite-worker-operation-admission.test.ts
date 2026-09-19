import { AsyncLocalStorage } from "node:async_hooks";
import { MessageChannel } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { withSqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";

afterEach(() => vi.restoreAllMocks());

it("shares the active operation across module copies without mixing nested ports", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  expect(duplicate.withSqliteWorkerOperationAdmission).not.toBe(withSqliteWorkerOperationAdmission);
  const outer = new MessageChannel();
  const inner = new MessageChannel();
  // Only the carrier is under test here. Real cross-thread grants and revocation
  // are covered by the publication and public-runtime reclamation tests.
  const grant = (message: { decision: SharedArrayBuffer }) => {
    Atomics.store(new Int32Array(message.decision), 0, 1);
  };
  const outerRequests = vi.spyOn(outer.port1, "postMessage").mockImplementation(grant);
  const innerRequests = vi.spyOn(inner.port1, "postMessage").mockImplementation(grant);
  const request = (facts: string) =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "transaction", facts });
  try {
    withSqliteWorkerOperationAdmission(outer.port1, () => {
      request("outer-before");
      duplicate.withSqliteWorkerOperationAdmission(inner.port1, () => request("inner"));
      request("outer-after");
    });
    expect(outerRequests.mock.calls.map(([message]) => message.facts)).toEqual([
      "outer-before",
      "outer-after",
    ]);
    expect(innerRequests.mock.calls.map(([message]) => message.facts)).toEqual(["inner"]);
    expect(() => request("outside")).toThrow("requires its retained admission");
    expect(outerRequests).toHaveBeenCalledTimes(2);
    expect(innerRequests).toHaveBeenCalledTimes(1);
  } finally {
    outer.port1.close();
    outer.port2.close();
    inner.port1.close();
    inner.port2.close();
  }
});

it("refuses escaped continuations and captured scopes after synchronous operation exit", async () => {
  vi.resetModules();
  const duplicate = await import("./sqlite-worker-operation-admission.js");
  const { port1, port2 } = new MessageChannel();
  const requests = vi.spyOn(port1, "postMessage");
  const request = () =>
    duplicate.requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
  try {
    const escaped = withSqliteWorkerOperationAdmission(port1, () =>
      Promise.resolve().then(request),
    );
    await expect(escaped).rejects.toThrow("requires its retained admission");
    const captured = withSqliteWorkerOperationAdmission(port1, () => AsyncLocalStorage.snapshot());
    expect(() => captured(request)).toThrow("requires its retained admission");
    let failedScope: ReturnType<typeof AsyncLocalStorage.snapshot> | undefined;
    expect(() =>
      withSqliteWorkerOperationAdmission(port1, () => {
        failedScope = AsyncLocalStorage.snapshot();
        throw new Error("operation failed");
      }),
    ).toThrow("operation failed");
    expect(failedScope).toBeDefined();
    expect(() => failedScope?.(request)).toThrow("requires its retained admission");
    expect(requests).not.toHaveBeenCalled();
  } finally {
    port1.close();
    port2.close();
  }
});
