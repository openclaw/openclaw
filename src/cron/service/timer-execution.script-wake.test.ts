import { describe, expect, it, vi } from "vitest";
import type { SessionEventTarget } from "../../auto-reply/reply/session-event-contract.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import type { CronStoredJob } from "../types.js";
import { createCronServiceState } from "./state.js";
import { executeJobCore } from "./timer-execution.js";

vi.mock("../proactive-job-receipt.js", () => ({
  readDefaultProactiveJobReceiptsAsync: async () => ({}),
}));

const target: SessionEventTarget = {
  agentId: "finn",
  sessionKey: "agent:finn:main",
  sessionId: "original-session",
  generation: "original-generation",
};

function createFixture(wake: "now" | "next-heartbeat", cronEnabled = true) {
  const enqueueSessionEvent = vi.fn();
  const deferSessionEvent = vi.fn();
  const captureSessionEventTarget = vi.fn(async () => target);
  const state = createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath: "/unused",
    cronEnabled,
    cronConfig: { triggers: { enabled: true } },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    enqueueSystemEvent: vi.fn(),
    enqueueSessionEvent,
    deferSessionEvent,
    captureSessionEventTarget,
    resolveSessionEventTarget: () => ({ agentId: "finn", sessionKey: target.sessionKey }),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    runScriptJob: vi.fn(async () => ({
      status: "ok" as const,
      notify: "Review the result.",
      wake,
    })),
  });
  state.stopped = false;
  const job: CronStoredJob = {
    id: "script-job",
    name: "Script",
    agentId: "finn",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "script", script: "return { wake: 'now' }" },
    state: {},
  };
  return { state, job, enqueueSessionEvent, deferSessionEvent, captureSessionEventTarget };
}

describe("script follow-up handoff", () => {
  it("sends an immediate follow-up to the captured session while scheduling is disabled", async () => {
    const fixture = createFixture("now", false);
    const result = await executeJobCore(fixture.state, fixture.job);
    expect(result.status).toBe("ok");
    expect(fixture.captureSessionEventTarget.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fixture.state.deps.runScriptJob!).mock.invocationCallOrder[0]!,
    );
    expect(fixture.enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith("Review the result.", {
      agentId: "finn",
      expectedTarget: target,
    });
    expect(fixture.state.deps.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(fixture.deferSessionEvent).not.toHaveBeenCalled();
  });

  it("attaches deferred follow-up to an enabled ordinary scheduled session job", async () => {
    const fixture = createFixture("next-heartbeat");
    const receiver: CronStoredJob = {
      ...fixture.job,
      id: "ordinary-receiver",
      sessionTarget: "session:agent:finn:main",
      payload: { kind: "agentTurn", message: "Review pending notices." },
      state: { nextRunAtMs: 60_000 },
    };
    fixture.state.store = { version: 1, jobs: [receiver] };
    expect(await executeJobCore(fixture.state, fixture.job)).toMatchObject({
      status: "ok" as const,
    });
    expect(fixture.deferSessionEvent).toHaveBeenCalledExactlyOnceWith(
      "Review the result.",
      receiver,
      target,
    );
    expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
    receiver.enabled = false;
    expect(await executeJobCore(fixture.state, fixture.job)).toMatchObject({
      status: "error",
      error: expect.stringContaining("No enabled ordinary scheduled session job"),
    });
    expect(fixture.deferSessionEvent).toHaveBeenCalledTimes(1);
  });

  it("records a visible error when the original destination cannot be captured", async () => {
    const fixture = createFixture("now");
    fixture.state.deps.captureSessionEventTarget = async () => undefined;
    expect(await executeJobCore(fixture.state, fixture.job)).toMatchObject({
      status: "error",
      error: expect.stringContaining("no original session target"),
    });
    expect(fixture.enqueueSessionEvent).not.toHaveBeenCalled();
  });
});
