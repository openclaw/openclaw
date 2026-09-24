import { describe, expect, it, vi } from "vitest";
import type { CronServiceState } from "./state.js";
import { wake } from "./wake.js";

function makeStateWithMocks(): {
  state: CronServiceState;
  enqueueSystemEvent: ReturnType<typeof vi.fn>;
  requestHeartbeat: ReturnType<typeof vi.fn>;
} {
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeat = vi.fn();
  const state = {
    deps: { enqueueSystemEvent, requestHeartbeat },
  } as unknown as CronServiceState;
  return { state, enqueueSystemEvent, requestHeartbeat };
}

describe("cron service wake() origin capture", () => {
  it("forwards sessionKey + agentId to enqueueSystemEvent so the event lands on the originating session", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    const result = wake(state, {
      mode: "now",
      text: "follow up on the report",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("follow up on the report", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
  });

  it("threads sessionKey + agentId into the targeted-immediate heartbeat for next-heartbeat+sessionKey too", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    const result = wake(state, {
      mode: "next-heartbeat",
      text: "check the queue",
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
  });

  it("forwards an agentId-only wake so the event reaches that agent's default lane", () => {
    // An agent-only origin must not fall back to the global default lane.
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    const result = wake(state, { mode: "now", text: "agent only", agentId: "ops" });
    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("agent only", {
      agentId: "ops",
    });
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
      agentId: "ops",
    });
  });

  it("drops whitespace-only sessionKey / agentId rather than routing to a meaningless lane", () => {
    const { state, enqueueSystemEvent, requestHeartbeat } = makeStateWithMocks();
    wake(state, {
      mode: "now",
      text: "x",
      sessionKey: "   ",
      agentId: "\t",
    });
    expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith("x", undefined);
    expect(requestHeartbeat).toHaveBeenCalledExactlyOnceWith({
      source: "manual",
      intent: "immediate",
      reason: "wake",
    });
  });
});
