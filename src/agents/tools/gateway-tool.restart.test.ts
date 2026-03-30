import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRestartReadinessGate } from "../../gateway/restart-recovery.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { ScheduledRestart } from "../../infra/restart.js";

const scheduleGatewaySigusr1Restart = vi.fn<
  (opts?: { delayMs?: number; reason?: string }) => ScheduledRestart
>(() => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR1" as const,
  delayMs: 0,
  mode: "emit" as const,
  coalesced: false,
  cooldownMsApplied: 0,
}));
const writeRestartSentinel = vi.fn<
  (payload: RestartSentinelPayload, env?: NodeJS.ProcessEnv) => Promise<string>
>(async () => "/tmp/restart-sentinel.json");
const evaluateGatewayRestartReadinessGate = vi.fn<() => GatewayRestartReadinessGate>(() => ({
  blocked: false,
  threshold: 0,
  summary: "",
  activeSessions: [],
  activeCronRuns: [],
  totalActive: 0,
}));

vi.mock("../../infra/restart.js", () => ({
  scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
    scheduleGatewaySigusr1Restart(opts),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  formatDoctorNonInteractiveHint: () => "Run: openclaw doctor --non-interactive",
  writeRestartSentinel: (payload: RestartSentinelPayload, env?: NodeJS.ProcessEnv) =>
    writeRestartSentinel(payload, env),
}));

vi.mock("../../gateway/restart-recovery.js", () => ({
  evaluateGatewayRestartReadinessGate: () => evaluateGatewayRestartReadinessGate(),
}));

describe("gateway tool restart", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    evaluateGatewayRestartReadinessGate.mockReturnValue({
      blocked: false,
      threshold: 0,
      summary: "",
      activeSessions: [],
      activeCronRuns: [],
      totalActive: 0,
    });
  });

  it("returns a force-required block when readiness gate is active", async () => {
    evaluateGatewayRestartReadinessGate.mockReturnValue({
      blocked: true,
      threshold: 0,
      summary:
        "1 active item(s) would be interrupted by gateway restart.\nRe-run with --force to proceed.",
      activeSessions: [{ key: "agent:main:main", status: "running", activeSubagents: [] }],
      activeCronRuns: [],
      totalActive: 1,
    });
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool();

    const result = await tool.execute?.("tool-1", {
      action: "restart",
      reason: "manual",
    });

    expect(result?.details).toMatchObject({
      ok: false,
      status: "blocked",
      requiresForce: true,
    });
    expect(scheduleGatewaySigusr1Restart).not.toHaveBeenCalled();
  });

  it("schedules restart when force is supplied", async () => {
    evaluateGatewayRestartReadinessGate.mockReturnValue({
      blocked: true,
      threshold: 0,
      summary: "blocked",
      activeSessions: [{ key: "agent:main:main", status: "running", activeSubagents: [] }],
      activeCronRuns: [],
      totalActive: 1,
    });
    const { createGatewayTool } = await import("./gateway-tool.js");
    const tool = createGatewayTool();

    const result = await tool.execute?.("tool-2", {
      action: "restart",
      reason: "manual",
      force: true,
    });

    expect(scheduleGatewaySigusr1Restart).toHaveBeenCalledWith({
      delayMs: undefined,
      reason: "manual",
    });
    expect(writeRestartSentinel).toHaveBeenCalledTimes(1);
    expect(result?.details).toMatchObject({
      ok: true,
      signal: "SIGUSR1",
    });
  });
});
