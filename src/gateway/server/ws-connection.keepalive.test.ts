// Unit tests for the WebSocket keepalive scheduler (fake timers + a stub socket).
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import {
  DEFAULT_KEEPALIVE_INTERVAL_MS,
  DEFAULT_KEEPALIVE_TIMEOUT_MS,
  resolveKeepAliveConfig,
  startKeepAlive,
} from "./ws-connection.keepalive.js";

type StubSocket = WebSocket & { ping: ReturnType<typeof vi.fn> };

function makeSocket(opts?: { pingThrows?: boolean }): StubSocket {
  const socket = new EventEmitter() as unknown as StubSocket;
  socket.ping = vi.fn(() => {
    if (opts?.pingThrows) {
      throw new Error("socket closing");
    }
  });
  return socket;
}

const config = { intervalMs: 2000, timeoutMs: 1000 };

describe("startKeepAlive", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("pings once the connection has been idle for interval", () => {
    const socket = makeSocket();
    const onUnresponsive = vi.fn();
    const handle = startKeepAlive(socket, config, onUnresponsive);

    expect(socket.ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(config.intervalMs);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(onUnresponsive).not.toHaveBeenCalled();

    handle.stop();
  });

  it("calls onUnresponsive once when no pong arrives within timeout", () => {
    const socket = makeSocket();
    const onUnresponsive = vi.fn();
    startKeepAlive(socket, config, onUnresponsive);

    vi.advanceTimersByTime(config.intervalMs); // ping sent
    expect(onUnresponsive).not.toHaveBeenCalled();
    vi.advanceTimersByTime(config.timeoutMs); // pong deadline elapses
    expect(onUnresponsive).toHaveBeenCalledTimes(1);

    // No second invocation even if more time passes.
    vi.advanceTimersByTime(config.intervalMs * 5);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
  });

  it("a pong cancels the deadline and restarts the idle clock", () => {
    const socket = makeSocket();
    const onUnresponsive = vi.fn();
    const handle = startKeepAlive(socket, config, onUnresponsive);

    vi.advanceTimersByTime(config.intervalMs); // first ping
    expect(socket.ping).toHaveBeenCalledTimes(1);
    socket.emit("pong"); // peer is alive

    vi.advanceTimersByTime(config.timeoutMs + 100); // old deadline window
    expect(onUnresponsive).not.toHaveBeenCalled();

    vi.advanceTimersByTime(config.intervalMs); // next idle interval -> ping again
    expect(socket.ping).toHaveBeenCalledTimes(2);

    handle.stop();
  });

  it("stop() clears timers and detaches the pong listener", () => {
    const socket = makeSocket();
    const onUnresponsive = vi.fn();
    const handle = startKeepAlive(socket, config, onUnresponsive);

    expect(socket.listenerCount("pong")).toBe(1);
    handle.stop();
    expect(socket.listenerCount("pong")).toBe(0);

    vi.advanceTimersByTime(config.intervalMs * 10);
    expect(socket.ping).not.toHaveBeenCalled();
    expect(onUnresponsive).not.toHaveBeenCalled();

    handle.stop(); // idempotent
  });

  it("does not arm a pong deadline if the ping throws (socket already closing)", () => {
    const socket = makeSocket({ pingThrows: true });
    const onUnresponsive = vi.fn();
    const handle = startKeepAlive(socket, config, onUnresponsive);

    vi.advanceTimersByTime(config.intervalMs); // probe -> ping throws -> returns
    vi.advanceTimersByTime(config.timeoutMs * 5);
    expect(onUnresponsive).not.toHaveBeenCalled();

    handle.stop();
  });
});

describe("resolveKeepAliveConfig", () => {
  it("applies defaults when the block is omitted or empty", () => {
    const expected = {
      intervalMs: DEFAULT_KEEPALIVE_INTERVAL_MS,
      timeoutMs: DEFAULT_KEEPALIVE_TIMEOUT_MS,
    };
    expect(resolveKeepAliveConfig(undefined)).toEqual(expected);
    expect(resolveKeepAliveConfig({})).toEqual(expected);
  });

  it("returns null when interval is 0 (operator opt-out)", () => {
    expect(resolveKeepAliveConfig({ interval: 0 })).toBeNull();
  });

  it("passes through explicit values and defaults the missing one", () => {
    expect(resolveKeepAliveConfig({ interval: 10_000, timeout: 2000 })).toEqual({
      intervalMs: 10_000,
      timeoutMs: 2000,
    });
    expect(resolveKeepAliveConfig({ timeout: 2000 })).toEqual({
      intervalMs: DEFAULT_KEEPALIVE_INTERVAL_MS,
      timeoutMs: 2000,
    });
  });
});
