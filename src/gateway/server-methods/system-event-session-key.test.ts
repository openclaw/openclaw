import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemPresence } from "../../infra/system-presence.js";

const mocks = vi.hoisted(() => ({
  resolveMainSessionKeyFromConfig: vi.fn(() => "agent:main:main"),
  canonicalizeWakeSessionKey: vi.fn((key: string) => `agent:main:${key}`),
  enqueueSystemEvent: vi.fn(),
  isSystemEventContextChanged: vi.fn(() => false),
  updateSystemPresence: vi.fn(() => ({
    key: "device-1",
    next: {},
    changedKeys: [] as (keyof SystemPresence)[],
  })),
  broadcastPresenceSnapshot: vi.fn(),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveMainSessionKeyFromConfig: mocks.resolveMainSessionKeyFromConfig,
}));

vi.mock("../session-utils.js", () => ({
  canonicalizeWakeSessionKey: mocks.canonicalizeWakeSessionKey,
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
  isSystemEventContextChanged: mocks.isSystemEventContextChanged,
}));

vi.mock("../../infra/system-presence.js", () => ({
  updateSystemPresence: mocks.updateSystemPresence,
  listSystemPresence: vi.fn(() => []),
}));

vi.mock("../server/presence-events.js", () => ({
  broadcastPresenceSnapshot: mocks.broadcastPresenceSnapshot,
}));

vi.mock("../../infra/heartbeat-events.js", () => ({
  getLastHeartbeatEvent: vi.fn(),
}));

vi.mock("../../infra/heartbeat-runner.js", () => ({
  setHeartbeatsEnabled: vi.fn(),
}));

const { systemHandlers } = await import("./system.js");

function callSystemEvent(params: Record<string, unknown>) {
  const respond = vi.fn();
  const context = {
    broadcast: vi.fn(),
    incrementPresenceVersion: vi.fn(),
    getHealthVersion: vi.fn(),
  };
  void systemHandlers["system-event"]({
    params,
    respond: respond as never,
    context: context as never,
    client: null,
    req: { type: "req", id: "req-sys-event", method: "system-event" },
    isWebchatConnect: () => false,
  });
  return { respond };
}

describe("systemHandlers.system-event sessionKey support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveMainSessionKeyFromConfig.mockReturnValue("agent:main:main");
    mocks.updateSystemPresence.mockReturnValue({
      key: "device-1",
      next: {},
      changedKeys: [],
    });
  });

  it("uses mainSessionKey when no sessionKey is provided", () => {
    const { respond } = callSystemEvent({ text: "hello world" });
    expect(mocks.canonicalizeWakeSessionKey).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("hello world", {
      sessionKey: "agent:main:main",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("uses mainSessionKey when sessionKey is whitespace-only", () => {
    callSystemEvent({ text: "hello", sessionKey: "   " });
    expect(mocks.canonicalizeWakeSessionKey).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("hello", {
      sessionKey: "agent:main:main",
    });
  });

  it("canonicalizes and uses provided sessionKey for non-node-presence events", () => {
    mocks.canonicalizeWakeSessionKey.mockReturnValue("agent:main:discord:channel:123");
    const { respond } = callSystemEvent({
      text: "deployment complete",
      sessionKey: "discord:channel:123",
    });
    expect(mocks.canonicalizeWakeSessionKey).toHaveBeenCalledWith("discord:channel:123");
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("deployment complete", {
      sessionKey: "agent:main:discord:channel:123",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  });

  it("trims sessionKey before canonicalizing", () => {
    mocks.canonicalizeWakeSessionKey.mockReturnValue("agent:main:hook:padded");
    callSystemEvent({
      text: "test event",
      sessionKey: "  hook:padded  ",
    });
    expect(mocks.canonicalizeWakeSessionKey).toHaveBeenCalledWith("hook:padded");
  });

  it("always uses mainSessionKey for node presence lines even when sessionKey is provided", () => {
    mocks.updateSystemPresence.mockReturnValue({
      key: "device-1",
      next: { host: "my-host", ip: "1.2.3.4" },
      changedKeys: ["host"],
    });
    callSystemEvent({
      text: "Node: my-host (1.2.3.4)",
      sessionKey: "discord:channel:123",
    });
    // Node presence should NOT canonicalize a custom sessionKey
    expect(mocks.canonicalizeWakeSessionKey).not.toHaveBeenCalled();
    // Should use mainSessionKey for node presence
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("returns error when text is empty", () => {
    const { respond } = callSystemEvent({ text: "", sessionKey: "hook:test" });
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("returns error when text is missing", () => {
    const { respond } = callSystemEvent({ sessionKey: "hook:test" });
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(false, undefined, expect.any(Object));
  });

  it("returns WS error frame when canonicalization throws", () => {
    mocks.canonicalizeWakeSessionKey.mockImplementation(() => {
      throw new Error(
        'session key "agent:ops:test" targets agent "ops" but the default agent is "main". Cross-agent wake is not supported.',
      );
    });
    const { respond } = callSystemEvent({
      text: "test event",
      sessionKey: "agent:ops:test",
    });
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Cross-agent wake is not supported"),
      }),
    );
  });
});
