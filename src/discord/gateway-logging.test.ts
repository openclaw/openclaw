import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

import { logVerbose } from "../globals.js";
import { attachDiscordGatewayLogging } from "./gateway-logging.js";

const makeRuntime = () => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
});

describe("attachDiscordGatewayLogging", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("logs debug events and promotes reconnect/close to info", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({
      emitter,
      runtime,
    });

    emitter.emit("debug", "WebSocket connection opened");
    emitter.emit("debug", "WebSocket connection closed with code 1001");
    emitter.emit("debug", "Reconnecting with backoff: 1000ms after code 1001");

    const logVerboseMock = vi.mocked(logVerbose);
    expect(logVerboseMock).toHaveBeenCalledTimes(3);
    expect(runtime.log).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenNthCalledWith(
      1,
      "discord gateway: WebSocket connection closed with code 1001",
    );
    expect(runtime.log).toHaveBeenNthCalledWith(
      2,
      "discord gateway: Reconnecting with backoff: 1000ms after code 1001",
    );

    cleanup();
  });

  it("logs warnings and metrics only to verbose", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({
      emitter,
      runtime,
    });

    emitter.emit("warning", "High latency detected: 1200ms");
    emitter.emit("metrics", { latency: 42, errors: 1 });

    const logVerboseMock = vi.mocked(logVerbose);
    expect(logVerboseMock).toHaveBeenCalledTimes(2);
    expect(runtime.log).not.toHaveBeenCalled();

    cleanup();
  });

  it("formats various metrics types via verbose logging", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({ emitter, runtime });
    const logVerboseMock = vi.mocked(logVerbose);

    emitter.emit("metrics", null);
    expect(logVerboseMock).toHaveBeenLastCalledWith("discord gateway metrics: null");

    emitter.emit("metrics", undefined);
    expect(logVerboseMock).toHaveBeenLastCalledWith("discord gateway metrics: undefined");

    emitter.emit("metrics", "plain string");
    expect(logVerboseMock).toHaveBeenLastCalledWith("discord gateway metrics: plain string");

    emitter.emit("metrics", 42);
    expect(logVerboseMock).toHaveBeenLastCalledWith("discord gateway metrics: 42");

    emitter.emit("metrics", true);
    expect(logVerboseMock).toHaveBeenLastCalledWith("discord gateway metrics: true");

    emitter.emit("metrics", BigInt(99));
    expect(logVerboseMock).toHaveBeenLastCalledWith("discord gateway metrics: 99");

    // Unserializable object (circular reference)
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    emitter.emit("metrics", circular);
    expect(logVerboseMock).toHaveBeenLastCalledWith(
      "discord gateway metrics: [unserializable metrics]",
    );

    cleanup();
  });

  it("returns no-op cleanup when emitter is undefined", () => {
    const runtime = makeRuntime();
    const cleanup = attachDiscordGatewayLogging({ emitter: undefined, runtime });
    expect(cleanup).toBeTypeOf("function");
    // Should not throw
    cleanup();
  });

  it("removes listeners on cleanup", () => {
    const emitter = new EventEmitter();
    const runtime = makeRuntime();

    const cleanup = attachDiscordGatewayLogging({
      emitter,
      runtime,
    });
    cleanup();

    const logVerboseMock = vi.mocked(logVerbose);
    logVerboseMock.mockClear();

    emitter.emit("debug", "WebSocket connection closed with code 1001");
    emitter.emit("warning", "High latency detected: 1200ms");
    emitter.emit("metrics", { latency: 42 });

    expect(logVerboseMock).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });
});
