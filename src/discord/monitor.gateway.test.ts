import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { waitForDiscordGatewayStop } from "./monitor.gateway.js";

function createGatewayWaitHarness() {
  const emitter = new EventEmitter();
  const disconnect = vi.fn();
  const abort = new AbortController();
  return { emitter, disconnect, abort };
}

function startGatewayWait(params?: {
  onGatewayError?: (error: unknown) => void;
  shouldStopOnError?: (error: unknown) => boolean;
  registerForceStop?: (fn: (error: unknown) => void) => void;
}) {
  const harness = createGatewayWaitHarness();
  const promise = waitForDiscordGatewayStop({
    gateway: { emitter: harness.emitter, disconnect: harness.disconnect },
    abortSignal: harness.abort.signal,
    ...(params?.onGatewayError ? { onGatewayError: params.onGatewayError } : {}),
    ...(params?.shouldStopOnError ? { shouldStopOnError: params.shouldStopOnError } : {}),
    ...(params?.registerForceStop ? { registerForceStop: params.registerForceStop } : {}),
  });
  return { ...harness, promise };
}

async function expectAbortToResolve(params: {
  emitter: EventEmitter;
  disconnect: ReturnType<typeof vi.fn>;
  abort: AbortController;
  promise: Promise<void>;
  expectedDisconnectBeforeAbort?: number;
}) {
  if (params.expectedDisconnectBeforeAbort !== undefined) {
    expect(params.disconnect).toHaveBeenCalledTimes(params.expectedDisconnectBeforeAbort);
  }
  expect(params.emitter.listenerCount("error")).toBe(1);
  params.abort.abort();
  await expect(params.promise).resolves.toBeUndefined();
  expect(params.disconnect).toHaveBeenCalledTimes(1);
  expect(params.emitter.listenerCount("error")).toBe(0);
}

describe("waitForDiscordGatewayStop", () => {
  it("resolves on abort and disconnects gateway", async () => {
    const { emitter, disconnect, abort, promise } = startGatewayWait();
    await expectAbortToResolve({ emitter, disconnect, abort, promise });
  });

  it("rejects on gateway error and disconnects", async () => {
    const onGatewayError = vi.fn();
    const err = new Error("boom");

    const { emitter, disconnect, abort, promise } = startGatewayWait({
      onGatewayError,
    });

    emitter.emit("error", err);

    await expect(promise).rejects.toThrow("boom");
    expect(onGatewayError).toHaveBeenCalledWith(err);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("error")).toBe(0);

    abort.abort();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("ignores gateway errors when instructed", async () => {
    const onGatewayError = vi.fn();
    const err = new Error("transient");

    const { emitter, disconnect, abort, promise } = startGatewayWait({
      onGatewayError,
      shouldStopOnError: () => false,
    });

    emitter.emit("error", err);
    expect(onGatewayError).toHaveBeenCalledWith(err);
    await expectAbortToResolve({
      emitter,
      disconnect,
      abort,
      promise,
      expectedDisconnectBeforeAbort: 0,
    });
  });

  it("resolves on abort without a gateway", async () => {
    const abort = new AbortController();

    const promise = waitForDiscordGatewayStop({
      abortSignal: abort.signal,
    });

    abort.abort();

    await expect(promise).resolves.toBeUndefined();
  });

  it("rejects via registerForceStop and disconnects gateway", async () => {
    let forceStop: ((err: unknown) => void) | undefined;

    const { emitter, disconnect, promise } = startGatewayWait({
      registerForceStop: (fn) => {
        forceStop = fn;
      },
    });

    expect(forceStop).toBeDefined();

    forceStop?.(new Error("reconnect watchdog timeout"));

    await expect(promise).rejects.toThrow("reconnect watchdog timeout");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("ignores forceStop after promise already settled", async () => {
    let forceStop: ((err: unknown) => void) | undefined;

    const { abort, disconnect, promise } = startGatewayWait({
      registerForceStop: (fn) => {
        forceStop = fn;
      },
    });

    abort.abort();
    await expect(promise).resolves.toBeUndefined();

    forceStop?.(new Error("too late"));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
