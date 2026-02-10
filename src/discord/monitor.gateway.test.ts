import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachDiscordRecoveryHandlers, waitForDiscordGatewayStop } from "./monitor.gateway.js";
import {
  getQueuedCount,
  isRecovering,
  queueDelivery,
  resetRecoveryStateForTest,
} from "./recovery-state.js";

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

describe("attachDiscordRecoveryHandlers", () => {
  const accountId = "test-recovery-handlers";

  beforeEach(() => {
    resetRecoveryStateForTest();
  });

  afterEach(() => {
    resetRecoveryStateForTest();
  });

  it("sets recovering on WebSocket connection closed", () => {
    const emitter = new EventEmitter();
    const stop = attachDiscordRecoveryHandlers({
      emitter,
      accountId,
    });

    emitter.emit("debug", "WebSocket connection closed");

    expect(isRecovering(accountId)).toBe(true);
    stop();
  });

  it("calls onQueued when replies are queued during disconnect", () => {
    const emitter = new EventEmitter();
    const onQueued = vi.fn();
    attachDiscordRecoveryHandlers({
      emitter,
      accountId,
      onQueued,
    });

    emitter.emit("debug", "WebSocket connection closed");

    expect(isRecovering(accountId)).toBe(true);
    expect(getQueuedCount(accountId)).toBe(0);
    expect(onQueued).not.toHaveBeenCalled();
  });

  it("clears recovering and flushes on WebSocket connection opened", async () => {
    const flushHandler = vi.fn(async () => {});
    const { setFlushHandler } = await import("./recovery-state.js");
    setFlushHandler(accountId, flushHandler);

    const emitter = new EventEmitter();
    const onFlushed = vi.fn();
    const stop = attachDiscordRecoveryHandlers({
      emitter,
      accountId,
      onFlushed,
    });

    emitter.emit("debug", "WebSocket connection closed");
    expect(isRecovering(accountId)).toBe(true);
    queueDelivery(accountId, {
      target: "discord:channel:123",
      replies: [{ text: "queued" }],
      token: "token",
      accountId,
      runtime: { log: () => {}, error: () => {} },
      textLimit: 2000,
    });
    expect(getQueuedCount(accountId)).toBe(1);

    emitter.emit("debug", "WebSocket connection opened");

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(isRecovering(accountId)).toBe(false);
    expect(flushHandler).toHaveBeenCalledTimes(1);
    expect(flushHandler).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ target: "discord:channel:123" })]),
    );
    expect(onFlushed).toHaveBeenCalledWith(1);
    stop();
  });

  it("does not set recovering when isShuttingDown returns true", () => {
    const emitter = new EventEmitter();
    const stop = attachDiscordRecoveryHandlers({
      emitter,
      accountId,
      isShuttingDown: () => true,
    });

    emitter.emit("debug", "WebSocket connection closed");

    expect(isRecovering(accountId)).toBe(false);
    stop();
  });

  it("returns no-op when emitter is undefined", () => {
    const stop = attachDiscordRecoveryHandlers({
      accountId,
    });
    expect(stop).toBeDefined();
    expect(typeof stop).toBe("function");
    stop();
  });
});
