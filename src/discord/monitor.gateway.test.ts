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
});
