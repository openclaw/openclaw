import { describe, expect, it, vi } from "vitest";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceState, type CronServiceDeps } from "./state.js";
import { wake } from "./wake.js";

function makeStateWithMocks() {
  const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "unused-wake-origin-store",
    cronEnabled: true,
    log: { debug() {}, info() {}, warn() {}, error() {} },
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob: vi.fn(),
    enqueueSessionEvent,
  });
  return { state, enqueueSessionEvent };
}

describe("cron service wake() origin capture", () => {
  for (const { name, mode, text, sessionKey, agentId } of [
    {
      name: "forwards sessionKey + agentId so the event lands on the originating session",
      mode: "now",
      text: "follow up on the report",
      sessionKey: "agent:main:telegram:8661849123:topic:4052",
      agentId: "main",
    },
    {
      name: "immediately admits an explicitly targeted session even with next-heartbeat mode",
      mode: "next-heartbeat",
      text: "check the queue",
      sessionKey: "agent:coding:discord:thread123",
      agentId: "coding",
    },
  ] as const) {
    it(name, async () => {
      const { state, enqueueSessionEvent } = makeStateWithMocks();
      const result = await wake(state, { mode, text, sessionKey, agentId });
      expect(result).toEqual({ ok: true });
      expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(text, { sessionKey, agentId });
    });
  }

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
