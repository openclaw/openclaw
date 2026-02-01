import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../globals.js", () => ({
  logVerbose: vi.fn(),
}));

import { logVerbose } from "../globals.js";
import { attachDiscordGatewayLogging } from "./gateway-logging.js";

const makeRuntime = () => ({
  log: vi.fn(),
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
