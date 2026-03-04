import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  canonicalizeWakeSessionKey: vi.fn((key: string) => `agent:main:${key}`),
  enqueueSystemEvent: vi.fn(),
  requestHeartbeatNow: vi.fn(),
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

// Dynamic import so mocks take effect
const { cronHandlers } = await import("./cron.js");

function callWake(params: Record<string, unknown>) {
  const respond = vi.fn();
  const cronWake = vi.fn(() => ({ ok: true }));
  void cronHandlers.wake({
    params,
    respond: respond as never,
    context: { cron: { wake: cronWake } } as never,
    client: null,
    req: { type: "req", id: "req-wake", method: "wake" },
    isWebchatConnect: () => false,
  });
  return { respond, cronWake };
}

describe("cronHandlers.wake sessionKey support", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses fan-out path when no sessionKey is provided", () => {
    const { respond, cronWake } = callWake({
      mode: "now",
      text: "hello",
    });
    expect(cronWake).toHaveBeenCalledWith({ mode: "now", text: "hello" });
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, mode: "now" }, undefined);
  });

  it("uses fan-out path when sessionKey is whitespace-only", () => {
    const { respond, cronWake } = callWake({
      mode: "now",
      text: "hello",
      sessionKey: "   ",
    });
    expect(cronWake).toHaveBeenCalledWith({ mode: "now", text: "hello" });
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, mode: "now" }, undefined);
  });

  it("returns ok:false when fan-out path has whitespace-only text", () => {
    const { respond, cronWake } = callWake({
      mode: "now",
      text: "   ",
    });
    expect(cronWake).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: false, error: "text required" }, undefined);
  });

  it("dispatches to canonicalized sessionKey when provided (mode=now)", () => {
    mocks.canonicalizeWakeSessionKey.mockReturnValue("agent:main:discord:channel:123");
    const { respond, cronWake } = callWake({
      mode: "now",
      text: "wake up",
      sessionKey: "discord:channel:123",
    });
    expect(cronWake).not.toHaveBeenCalled();
    expect(mocks.canonicalizeWakeSessionKey).toHaveBeenCalledWith("discord:channel:123");
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("wake up", {
      sessionKey: "agent:main:discord:channel:123",
    });
    expect(mocks.requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "wake",
      sessionKey: "agent:main:discord:channel:123",
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true, mode: "now" }, undefined);
  });

  it("dispatches to canonicalized sessionKey without heartbeat for mode=next-heartbeat", () => {
    mocks.canonicalizeWakeSessionKey.mockReturnValue("agent:main:hook:my-session");
    const { respond, cronWake } = callWake({
      mode: "next-heartbeat",
      text: "deferred event",
      sessionKey: "hook:my-session",
    });
    expect(cronWake).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith("deferred event", {
      sessionKey: "agent:main:hook:my-session",
    });
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: true, mode: "next-heartbeat" }, undefined);
  });

  it("returns ok:false when targeted path has whitespace-only text", () => {
    const { respond, cronWake } = callWake({
      mode: "now",
      text: "   ",
      sessionKey: "hook:my-session",
    });
    expect(cronWake).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(true, { ok: false, error: "text required" }, undefined);
  });

  it("trims sessionKey before canonicalizing", () => {
    mocks.canonicalizeWakeSessionKey.mockReturnValue("agent:main:hook:padded");
    callWake({
      mode: "now",
      text: "test",
      sessionKey: "  hook:padded  ",
    });
    expect(mocks.canonicalizeWakeSessionKey).toHaveBeenCalledWith("hook:padded");
  });

  it("returns WS error frame when canonicalization throws", () => {
    mocks.canonicalizeWakeSessionKey.mockImplementation(() => {
      throw new Error(
        'session key "agent:ops:test" targets agent "ops" but the default agent is "main". Cross-agent wake is not supported.',
      );
    });
    const { respond, cronWake } = callWake({
      mode: "now",
      text: "test",
      sessionKey: "agent:ops:test",
    });
    expect(cronWake).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeatNow).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("Cross-agent wake is not supported"),
      }),
    );
  });
});
