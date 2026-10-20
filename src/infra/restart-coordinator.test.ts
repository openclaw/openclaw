import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as acpTurns from "../acp/control-plane/active-turns.js";
import * as backgroundExec from "../agents/bash-process-registry.js";
import * as mediaRuns from "../agents/media-generation-activity.js";
import * as replies from "../auto-reply/reply/dispatcher-registry.js";
import * as cronJobs from "../cron/active-jobs.js";
import * as cronTasks from "../cron/service/active-run-cancellation.js";
import * as queue from "../process/command-queue.js";
import * as gatewayWork from "../process/gateway-work-admission.js";
import * as sessionRuns from "../sessions/session-controller.queries.js";
import * as agentRuns from "./agent-run-registry.js";
import {
  createSafeGatewayRestartPreflight,
  scheduleSafeGatewayRestart,
} from "./restart-coordinator.js";

const scheduleGatewayRestart = vi.hoisted(() => vi.fn());

// mock-isolation: Observe restart scheduling without signaling the test process.
vi.mock("./restart.js", () => ({ scheduleGatewayRestart }));

// The snapshot captures these counter functions when its module loads.
vi.mock("../acp/control-plane/active-turns.js", { spy: true });
vi.mock("../agents/bash-process-registry.js", { spy: true });
vi.mock("../agents/media-generation-activity.js", { spy: true });
vi.mock("../auto-reply/reply/dispatcher-registry.js", { spy: true });
vi.mock("../process/command-queue.js", { spy: true });
vi.mock("../sessions/session-controller.queries.js", { spy: true });
vi.mock("./agent-run-registry.js", { spy: true });

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
  gatewayWork.resetGatewayWorkAdmission();
  scheduleGatewayRestart.mockReset().mockReturnValue(restart);
  vi.mocked(queue.getTotalQueueSize).mockReturnValue(0);
  vi.mocked(replies.getTotalPendingReplies).mockReturnValue(0);
  vi.mocked(sessionRuns.getActiveSessionRunCount).mockReturnValue(0);
  vi.mocked(backgroundExec.getActiveBackgroundExecSessionCount).mockReturnValue(0);
  vi.mocked(agentRuns.getActiveAgentRunContextCount).mockReturnValue(0);
  vi.mocked(acpTurns.getActiveAcpTurnCount).mockReturnValue(0);
  vi.mocked(mediaRuns.getActiveMediaGenerationRunCount).mockReturnValue(0);
  vi.spyOn(cronJobs, "getActiveCronJobCount").mockReturnValue(0);
  vi.spyOn(cronTasks, "getSuspensionVisibleCronTaskRunCount").mockReturnValue(0);
});

afterEach(() => {
  gatewayWork.resetGatewayWorkAdmission();
  vi.restoreAllMocks();
});

describe("safe gateway restart coordinator", () => {
  it("reports safe when no restart blockers are active", () => {
    const preflight = createSafeGatewayRestartPreflight();

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
    vi.mocked(queue.getTotalQueueSize).mockReturnValue(2);
    vi.mocked(replies.getTotalPendingReplies).mockReturnValue(1);
    vi.mocked(sessionRuns.getActiveSessionRunCount).mockReturnValue(1);
    vi.mocked(cronJobs.getActiveCronJobCount).mockReturnValue(1);
    vi.spyOn(gatewayWork, "getActiveGatewayRootWorkCount").mockReturnValue(1);
    vi.mocked(agentRuns.getActiveAgentRunContextCount).mockReturnValue(1);
    vi.mocked(acpTurns.getActiveAcpTurnCount).mockReturnValue(2);
    vi.mocked(mediaRuns.getActiveMediaGenerationRunCount).mockReturnValue(3);
    const preflight = createSafeGatewayRestartPreflight();

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
    vi.mocked(backgroundExec.getActiveBackgroundExecSessionCount).mockReturnValue(2);
    const preflight = createSafeGatewayRestartPreflight();

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
    const handoff = gatewayWork.tryBeginGatewayRootWorkAdmission("subagents:spawn-handoff");
    const request = gatewayWork.tryBeginGatewayRootWorkAdmission("ws:gateway.restart");
    expect(handoff).not.toBeNull();
    expect(request).not.toBeNull();

    try {
      await request?.run(async () => {
        const preflight = createSafeGatewayRestartPreflight();

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
    vi.mocked(queue.getTotalQueueSize).mockReturnValue(active);
    const result = scheduleSafeGatewayRestart({
      reason: coalesced ? undefined : "test.safe",
      skipDeferral,
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
