import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  requestHeartbeat: vi.fn(),
}));

vi.mock("../../../infra/system-events.js", () => ({
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));

vi.mock("../../../infra/heartbeat-wake.js", () => ({
  requestHeartbeat: mocks.requestHeartbeat,
}));

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: vi.fn() }),
}));

import handler from "./handler.js";

const CONTINUE_HISTORY_KEY = Symbol.for("openclaw.autoContinueHistory");

function abortEvent(sessionKey: string) {
  return {
    type: "session" as const,
    action: "aborted",
    sessionKey,
    context: {},
    timestamp: new Date(),
    messages: [],
  };
}

function resetHistory() {
  (globalThis as Record<symbol, unknown>)[CONTINUE_HISTORY_KEY] = new Map();
}

describe("auto-continue handler", () => {
  beforeEach(() => {
    mocks.enqueueSystemEvent.mockReset();
    mocks.requestHeartbeat.mockReset();
    resetHistory();
  });

  it("queues a continuation and wakes the heartbeat on session:aborted", async () => {
    await handler(abortEvent("agent:main:main"));

    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledWith(expect.any(String), {
      sessionKey: "agent:main:main",
    });
    // "event" would defer to the next scheduled heartbeat for every abort after
    // the first, which leaves the run silent exactly when it needs resuming.
    expect(mocks.requestHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "agent:main:main", intent: "immediate" }),
    );
  });

  it("ignores non-aborted session events", async () => {
    await handler({ ...abortEvent("agent:main:main"), action: "started" });
    await handler({ ...abortEvent("agent:main:main"), type: "command" });

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(mocks.requestHeartbeat).not.toHaveBeenCalled();
  });

  it("ignores events without a session key", async () => {
    await handler({ ...abortEvent("   "), sessionKey: "" });

    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("stops resuming after the per-session budget is exhausted", async () => {
    for (let i = 0; i < 3; i++) {
      await handler(abortEvent("agent:main:main"));
    }
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(3);

    await handler(abortEvent("agent:main:main"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(3);
    expect(mocks.requestHeartbeat).toHaveBeenCalledTimes(3);
  });

  it("tracks the budget per session key independently", async () => {
    for (let i = 0; i < 3; i++) {
      await handler(abortEvent("agent:main:main"));
    }
    await handler(abortEvent("agent:main:main"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(3);

    await handler(abortEvent("agent:other:lane"));
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledTimes(4);
  });
});
