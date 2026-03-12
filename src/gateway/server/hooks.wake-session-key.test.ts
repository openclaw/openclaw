import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../../cli/deps.js";

type DispatchWakeHook = (value: {
  text: string;
  mode: "now" | "next-heartbeat";
  sessionKey?: string;
}) => { ok: true } | { ok: false; error: string };

const captured = vi.hoisted(() => ({
  dispatchWakeHook: null as DispatchWakeHook | null,
}));

const mocks = vi.hoisted(() => ({
  canonicalizeWakeSessionKey: vi.fn((key: string) => `agent:main:${key}`),
  enqueueSystemEvent: vi.fn(),
  requestHeartbeatNow: vi.fn(),
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  createHooksRequestHandler: vi.fn((opts: { dispatchWakeHook: DispatchWakeHook }) => {
    captured.dispatchWakeHook = opts.dispatchWakeHook;
    return vi.fn();
  }),
}));

vi.mock("../session-utils.js", () => ({
  canonicalizeWakeSessionKey: mocks.canonicalizeWakeSessionKey,
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: mocks.requestHeartbeatNow,
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../server-http.js", () => ({
  createHooksRequestHandler: mocks.createHooksRequestHandler,
}));

const { createGatewayHooksRequestHandler } = await import("./hooks.js");

function getDispatchWakeHook(): DispatchWakeHook {
  captured.dispatchWakeHook = null;
  createGatewayHooksRequestHandler({
    deps: {} as CliDeps,
    getHooksConfig: () => null,
    bindHost: "127.0.0.1",
    port: 18789,
    logHooks: {
      warn: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    } as never,
  });
  if (!captured.dispatchWakeHook) {
    throw new Error("dispatchWakeHook was not captured");
  }
  return captured.dispatchWakeHook;
}

describe("createGatewayHooksRequestHandler dispatchWakeHook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always requests heartbeat for targeted next-heartbeat wake", () => {
    const dispatchWakeHook = getDispatchWakeHook();

    const result = dispatchWakeHook({
      text: "deferred",
      mode: "next-heartbeat",
      sessionKey: "hook:my-session",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.canonicalizeWakeSessionKey).toHaveBeenCalledWith("hook:my-session");
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("deferred", {
      sessionKey: "agent:main:hook:my-session",
    });
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "hook:wake",
      sessionKey: "agent:main:hook:my-session",
    });
  });

  it("keeps fan-out next-heartbeat deferred when sessionKey is absent", () => {
    const dispatchWakeHook = getDispatchWakeHook();

    const result = dispatchWakeHook({
      text: "fanout",
      mode: "next-heartbeat",
    });

    expect(result).toEqual({ ok: true });
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("fanout", {
      sessionKey: "agent:main:main",
    });
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
  });
});
