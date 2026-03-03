import { beforeEach, describe, expect, test, vi } from "vitest";

const { enqueueSystemEventMock, requestHeartbeatNowMock, resolveMainKeyMock } = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  resolveMainKeyMock: vi.fn(() => "agent:main:main"),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: enqueueSystemEventMock,
}));
vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: requestHeartbeatNowMock,
}));
vi.mock("../../config/sessions/main-session.js", () => ({
  resolveMainSessionKeyFromConfig: resolveMainKeyMock,
}));

// Minimal stubs for transitive deps that createGatewayHooksRequestHandler pulls in.
vi.mock("../../config/config.js", () => ({
  loadConfig: vi.fn(() => ({})),
  STATE_DIR: "/tmp",
}));
vi.mock("../../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: vi.fn(),
}));

import type { WakePayload } from "../hooks.js";

// Extract dispatchWakeHook by capturing the callback passed to createHooksRequestHandler.
let capturedDispatchWake: ((value: WakePayload) => void) | undefined;

vi.mock("../server-http.js", () => ({
  createHooksRequestHandler: (opts: { dispatchWakeHook: (v: WakePayload) => void }) => {
    capturedDispatchWake = opts.dispatchWakeHook;
    return vi.fn();
  },
}));

import { createGatewayHooksRequestHandler } from "./hooks.js";

function setup() {
  createGatewayHooksRequestHandler({
    deps: {} as Parameters<typeof createGatewayHooksRequestHandler>[0]["deps"],
    getHooksConfig: () => null,
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as Parameters<typeof createGatewayHooksRequestHandler>[0]["logHooks"],
  });
  if (!capturedDispatchWake) {
    throw new Error("dispatchWakeHook was not captured");
  }
  return capturedDispatchWake;
}

describe("dispatchWakeHook sessionKey normalization", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    resolveMainKeyMock.mockClear();
    capturedDispatchWake = undefined;
  });

  test("passes normalized sessionKey (not raw) to requestHeartbeatNow when sessionKey is provided", () => {
    const dispatch = setup();
    const customKey = "agent:main:discord:channel:999";

    dispatch({ text: "hello", mode: "now", sessionKey: customKey });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("hello", { sessionKey: customKey });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "hook:wake",
      sessionKey: customKey,
    });
    // Should not fall back to main key since a sessionKey was provided.
    expect(resolveMainKeyMock).not.toHaveBeenCalled();
  });

  test("falls back to main session key when no sessionKey is provided", () => {
    const dispatch = setup();

    dispatch({ text: "hello", mode: "now" });

    expect(resolveMainKeyMock).toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("hello", {
      sessionKey: "agent:main:main",
    });
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith({
      reason: "hook:wake",
      sessionKey: "agent:main:main",
    });
  });

  test("does not call requestHeartbeatNow for next-heartbeat mode", () => {
    const dispatch = setup();

    dispatch({ text: "deferred", mode: "next-heartbeat", sessionKey: "custom:key" });

    expect(enqueueSystemEventMock).toHaveBeenCalledWith("deferred", {
      sessionKey: "agent:main:custom:key",
    });
    expect(requestHeartbeatNowMock).not.toHaveBeenCalled();
  });
});
