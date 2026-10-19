import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import {
  createSafeGatewayRestartPreflight,
  scheduleSafeGatewayRestart,
} from "./restart-coordinator.js";

const scheduleGatewayRestart = vi.hoisted(() => vi.fn());

// mock-isolation: Observe restart scheduling without signaling the test process.
vi.mock("./restart.js", () => ({ scheduleGatewayRestart }));

const restart = {
  ok: true,
  pid: 123,
  signal: "SIGUSR2",
  delayMs: 0,
  mode: "emit",
  coalesced: false,
  cooldownMsApplied: 0,
};

beforeEach(() => {
  resetGatewayWorkAdmission();
  scheduleGatewayRestart.mockReset().mockReturnValue(restart);
});

afterEach(resetGatewayWorkAdmission);

const idleInspect = {
  getQueueSize: () => 0,
  getPendingReplies: () => 0,
  getEmbeddedRuns: () => 0,
  getCronRuns: () => 0,
  getAgentRuns: () => 0,
  getAcpRuns: () => 0,
  getMediaRuns: () => 0,
};

describe("safe gateway restart coordinator", () => {
  const requestPreflight = (
    inspect: NonNullable<Parameters<typeof scheduleSafeGatewayRestart>[0]>["inspect"],
  ) => createSafeGatewayRestartPreflight({ ...idleInspect, ...inspect });

  it("reports safe when no restart blockers are active", () => {
    const preflight = requestPreflight({
      getBackgroundExecSessions: () => 0,
      getRootRequests: () => 0,
    });

    expect(preflight).toEqual({
      safe: true,
      counts: {
        queueSize: 0,
        pendingReplies: 0,
        embeddedRuns: 0,
        cronRuns: 0,
        backgroundExecSessions: 0,
        rootRequests: 0,
        agentRuns: 0,
        acpRuns: 0,
        mediaRuns: 0,
        totalActive: 0,
      },
      blockers: [],
      summary: "safe to restart now",
    });
  });

  it("returns structured blockers for active work", () => {
    const preflight = requestPreflight({
      getQueueSize: () => 2,
      getPendingReplies: () => 1,
      getEmbeddedRuns: () => 1,
      getCronRuns: () => 1,
      getBackgroundExecSessions: () => 0,
      getRootRequests: () => 1,
      getAgentRuns: () => 1,
      getAcpRuns: () => 2,
      getMediaRuns: () => 3,
    });

    expect(preflight.safe).toBe(false);
    expect(preflight.counts.totalActive).toBe(12);
    expect(preflight.blockers.map((blocker) => blocker.kind)).toEqual([
      "queue",
      "reply",
      "embedded-run",
      "cron-run",
      "agent-run",
      "acp-run",
      "media-generation",
      "root-request",
    ]);
    expect(preflight.summary).toContain("restart deferred");
    expect(preflight.summary).toContain("1 admitted agent run(s)");
  });

  it("defers restart for aggregate background exec sessions", () => {
    const preflight = requestPreflight({
      getBackgroundExecSessions: () => 2,
      getRootRequests: () => 0,
    });

    expect(preflight.safe).toBe(false);
    expect(preflight.counts).toMatchObject({
      backgroundExecSessions: 2,
      totalActive: 2,
    });
    expect(preflight.blockers).toEqual([
      {
        kind: "background-exec",
        count: 2,
        message: "2 active background exec session(s)",
      },
    ]);
    expect(preflight.summary).toBe("restart deferred: 2 active background exec session(s)");
  });

  it("counts an admitted spawn handoff while excluding the preflight request", async () => {
    const handoff = tryBeginGatewayRootWorkAdmission("subagents:spawn-handoff");
    const request = tryBeginGatewayRootWorkAdmission("ws:gateway.restart");
    expect(handoff).not.toBeNull();
    expect(request).not.toBeNull();

    try {
      await request?.run(async () => {
        const preflight = createSafeGatewayRestartPreflight({
          ...idleInspect,
          getBackgroundExecSessions: () => 0,
        });

        expect(preflight.counts).toMatchObject({ rootRequests: 1, totalActive: 1 });
        expect(preflight.blockers).toEqual([
          {
            kind: "root-request",
            count: 1,
            message: "1 active gateway request(s): subagents:spawn-handoff",
          },
        ]);
      });
    } finally {
      request?.release();
      handoff?.release();
    }
  });

  it.each([
    { status: "deferred", active: 1, skipDeferral: false, coalesced: false },
    { status: "coalesced", active: 0, skipDeferral: false, coalesced: true },
    { status: "scheduled", active: 1, skipDeferral: true, coalesced: false },
  ])("reports $status for safe restart requests", ({ status, active, skipDeferral, coalesced }) => {
    scheduleGatewayRestart.mockReturnValueOnce({
      ...restart,
      coalesced,
      delayMs: coalesced ? 500 : 0,
    });
    const result = scheduleSafeGatewayRestart({
      reason: coalesced ? undefined : "test.safe",
      skipDeferral,
      inspect: { ...idleInspect, getQueueSize: () => active },
    });
    expect(result).toMatchObject({ status, preflight: { safe: active === 0 } });
    expect(scheduleGatewayRestart).toHaveBeenCalledWith({
      delayMs: 0,
      reason: coalesced ? "gateway.restart.safe" : "test.safe",
      ...(skipDeferral
        ? { preservePendingEmitHooksOnDeferralBypass: true, skipDeferral: true }
        : {}),
    });
  });
});
