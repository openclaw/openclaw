// Covers safe gateway restart preflight and requests.
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

vi.mock("./restart.js", () => ({
  scheduleGatewayRestart: (opts: unknown) => scheduleGatewayRestart(opts),
}));

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

afterEach(() => {
  resetGatewayWorkAdmission();
});

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

  it("counts an admitted spawn handoff while excluding the preflight request", async () => {
    const handoff = tryBeginGatewayRootWorkAdmission("subagents:spawn-handoff");
    const request = tryBeginGatewayRootWorkAdmission("ws:gateway.restart");
    expect(handoff).not.toBeNull();
    expect(request).not.toBeNull();

    try {
      await request?.run(async () => {
        const preflight = requestPreflight({ getBackgroundExecSessions: () => 0 });

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

  it("schedules one restart request and marks active work as deferred", () => {
    const result = scheduleSafeGatewayRestart({
      reason: "test.safe",
      inspect: {
        ...idleInspect,
        getQueueSize: () => 1,
      },
    });

    expect(result.status).toBe("deferred");
    expect(scheduleGatewayRestart).toHaveBeenCalledWith({
      delayMs: 0,
      reason: "test.safe",
    });
  });

  it("surfaces coalesced restart requests", () => {
    scheduleGatewayRestart.mockReturnValueOnce({
      ...restart,
      delayMs: 500,
      coalesced: true,
    });

    const result = scheduleSafeGatewayRestart({
      inspect: {
        ...idleInspect,
      },
    });

    expect(result.status).toBe("coalesced");
  });

  it("forwards skipDeferral to scheduleGatewayRestart and marks status scheduled", () => {
    const result = scheduleSafeGatewayRestart({
      reason: "test.skip-deferral",
      skipDeferral: true,
      inspect: {
        ...idleInspect,
        getQueueSize: () => 1,
      },
    });

    expect(result.status).toBe("scheduled");
    expect(result.preflight.safe).toBe(false);
    expect(scheduleGatewayRestart).toHaveBeenCalledWith({
      delayMs: 0,
      preservePendingEmitHooksOnDeferralBypass: true,
      reason: "test.skip-deferral",
      skipDeferral: true,
    });
  });
});
