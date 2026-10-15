import { describe, expect, it, vi } from "vitest";
import type { CronServiceState } from "./state.js";
import { wake } from "./wake.js";

function makeStateWithMocks(): {
  state: CronServiceState;
  enqueueSessionEvent: ReturnType<typeof vi.fn>;
} {
  const enqueueSessionEvent = vi.fn();
  const state = {
    deps: { enqueueSessionEvent },
  } as unknown as CronServiceState;
  return { state, enqueueSessionEvent };
}

describe("cron service wake() origin capture", () => {
  it("forwards sessionKey + agentId so the event lands on the originating session", async () => {
    const { state, enqueueSessionEvent } = makeStateWithMocks();
    const result = await wake(state, {
      mode: "now",
      text: "follow up on the report",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("follow up on the report", {
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    });
  });

  it("immediately admits an explicitly targeted session even with next-heartbeat mode", async () => {
    const { state, enqueueSessionEvent } = makeStateWithMocks();
    const result = await wake(state, {
      mode: "next-heartbeat",
      text: "check the queue",
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("check the queue", {
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    });
  });

  it("forwards an agentId-only wake so the event reaches that agent's default lane", async () => {
    // An agent-only origin must not fall back to the global default lane.
    const { state, enqueueSessionEvent } = makeStateWithMocks();
    const result = await wake(state, { mode: "now", text: "agent only", agentId: "ops" });
    expect(result).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("agent only", {
      agentId: "ops",
    });
  });

  it("drops whitespace-only sessionKey / agentId rather than routing to a meaningless lane", async () => {
    const { state, enqueueSessionEvent } = makeStateWithMocks();
    const result = await wake(state, {
      mode: "now",
      text: "x",
      sessionKey: "   ",
      agentId: "\t",
    });
    expect(result).toEqual({ ok: true });
    expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("x", {
      createIfMissing: undefined,
      assertAcceptanceCurrent: undefined,
    });
  });
});
