import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { waitForDiscordGatewayStop } from "./monitor.gateway.js";

describe("waitForDiscordGatewayStop", () => {
  it("resolves on abort and disconnects gateway", async () => {
    const emitter = new EventEmitter();
    const disconnect = vi.fn();
    const abort = new AbortController();

    const promise = waitForDiscordGatewayStop({
      gateway: { emitter, disconnect },
      abortSignal: abort.signal,
    });

    expect(emitter.listenerCount("error")).toBe(1);
    abort.abort();

    await expect(promise).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("error")).toBe(0);
  });

  it("rejects on gateway error and disconnects", async () => {
    const emitter = new EventEmitter();
    const disconnect = vi.fn();
    const onGatewayError = vi.fn();
    const abort = new AbortController();
    const err = new Error("boom");

    const promise = waitForDiscordGatewayStop({
      gateway: { emitter, disconnect },
      abortSignal: abort.signal,
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
    const emitter = new EventEmitter();
    const disconnect = vi.fn();
    const onGatewayError = vi.fn();
    const abort = new AbortController();
    const err = new Error("transient");

    const promise = waitForDiscordGatewayStop({
      gateway: { emitter, disconnect },
      abortSignal: abort.signal,
      onGatewayError,
      shouldStopOnError: () => false,
    });

    emitter.emit("error", err);
    expect(onGatewayError).toHaveBeenCalledWith(err);
    expect(disconnect).toHaveBeenCalledTimes(0);
    expect(emitter.listenerCount("error")).toBe(1);

    abort.abort();
    await expect(promise).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("error")).toBe(0);
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
    const emitter = new EventEmitter();
    const disconnect = vi.fn();
    const abort = new AbortController();
    let forceStop: ((err: unknown) => void) | undefined;

    const promise = waitForDiscordGatewayStop({
      gateway: { emitter, disconnect },
      abortSignal: abort.signal,
      registerForceStop: (fn) => {
        forceStop = fn;
      },
    });

    expect(forceStop).toBeDefined();

    const err = new Error("reconnect watchdog timeout");
    forceStop!(err);

    await expect(promise).rejects.toThrow("reconnect watchdog timeout");
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(emitter.listenerCount("error")).toBe(0);

    // Subsequent abort is a no-op (already settled).
    abort.abort();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("forceStop is idempotent — second call has no effect", async () => {
    const emitter = new EventEmitter();
    const disconnect = vi.fn();
    const abort = new AbortController();
    let forceStop: ((err: unknown) => void) | undefined;

    const promise = waitForDiscordGatewayStop({
      gateway: { emitter, disconnect },
      abortSignal: abort.signal,
      registerForceStop: (fn) => {
        forceStop = fn;
      },
    });

    const err = new Error("watchdog");
    forceStop!(err);
    forceStop!(new Error("second call — should be ignored"));

    await expect(promise).rejects.toThrow("watchdog");
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("abort wins over registerForceStop when abort fires first", async () => {
    const emitter = new EventEmitter();
    const disconnect = vi.fn();
    const abort = new AbortController();
    let forceStop: ((err: unknown) => void) | undefined;

    const promise = waitForDiscordGatewayStop({
      gateway: { emitter, disconnect },
      abortSignal: abort.signal,
      registerForceStop: (fn) => {
        forceStop = fn;
      },
    });

    abort.abort();
    await expect(promise).resolves.toBeUndefined();

    // forceStop called after settlement is a no-op.
    forceStop!(new Error("too late"));
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
