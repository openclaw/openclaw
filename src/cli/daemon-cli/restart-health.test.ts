import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayService } from "../../daemon/service.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import {
  classifyPortListener,
  inspectAmbiguousOwnershipWithProbe,
  inspectGatewayRestartWithSnapshot,
  inspectPortUsage,
  inspectUnknownListener,
  makeGatewayService,
  monotonicClock,
  callGateway,
  gatewayResponseError,
  readGatewayOwnerLease,
  portUsage,
  resetRestartHealthMocks,
  resolveGatewayServiceProbeHosts,
  restoreRestartHealthMocks,
} from "./restart-health.test-helpers.js";

function ownerLease(pid: number, state: "live" | "dead" = "live", startedAt = 1000) {
  return {
    owner: `owner-${pid}`,
    pid,
    host: "gateway-test-host",
    startedAt,
    port: 18789,
    mode: "supervised" as const,
    supervisor: { kind: "schtasks" as const, name: "OpenClaw Gateway" },
    state,
    expired: state === "dead",
  };
}

describe("restart health", () => {
  beforeEach(resetRestartHealthMocks);
  afterEach(restoreRestartHealthMocks);

  it("preserves the recorded owner through the reporter's ordered task restart samples", async () => {
    // #140162's task CSV: the service child outlives its intermediate launcher.
    const samples = (
      [
        ["03:39:39.953", 6496, 6464, 6464, true],
        ["03:39:43.480", 11276, undefined, undefined, false],
        ["03:39:51.184", 11276, undefined, undefined, false],
        ["03:39:58.946", 11276, undefined, undefined, false],
        ["03:40:06.632", 11276, 2080, undefined, false],
        ["03:40:14.378", 11276, 2080, undefined, false],
        ["03:40:22.343", 11276, 2080, undefined, false],
        ["03:40:31.899", 11276, 2080, 2080, false],
        ["03:40:38.591", 11276, 2080, 2080, true],
      ] as const
    ).map(([at, runtimePid, ownerPid, listenerPid, ready]) => ({
      at,
      runtimePid,
      ownerPid,
      listenerPid,
      ready,
    }));
    const observed: Array<{ at: string; healthy: boolean; staleGatewayPids: number[] }> = [];
    for (const sample of samples) {
      readGatewayOwnerLease.mockReturnValue(
        sample.ownerPid === undefined
          ? undefined
          : ownerLease(sample.ownerPid, "live", sample.ownerPid === 6464 ? 1000 : 2000),
      );
      if (sample.ready) {
        callGateway.mockImplementation(gatewayHealthResponse());
      } else {
        callGateway.mockRejectedValue(new Error("connect ECONNREFUSED"));
      }
      const snapshot = await inspectGatewayRestartWithSnapshot({
        runtime: { status: "running", pid: sample.runtimePid },
        portUsage: {
          port: 18789,
          status: sample.listenerPid === undefined ? "free" : "busy",
          listeners:
            sample.listenerPid === undefined
              ? []
              : [
                  {
                    pid: sample.listenerPid,
                    ppid: sample.listenerPid === 6464 ? 13256 : 6292,
                    commandLine: "openclaw-gateway",
                  },
                ],
          hints: [],
        },
      });
      observed.push({
        at: sample.at,
        healthy: snapshot.healthy,
        staleGatewayPids: snapshot.staleGatewayPids,
      });
    }
    expect(observed).toEqual(
      samples.map((sample) => ({
        at: sample.at,
        healthy: sample.ready,
        staleGatewayPids: [],
      })),
    );
  });

  it("does not classify a dead recorded owner as stale", async () => {
    readGatewayOwnerLease.mockReturnValue(ownerLease(9000, "dead"));
    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "stopped" },
      portUsage: portUsage([{ pid: 9000, commandLine: "openclaw-gateway" }]),
    });
    expect(snapshot.healthy).toBe(false);
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("does not classify another listener as stale when a different Gateway owns the lifecycle", async () => {
    readGatewayOwnerLease.mockReturnValue(ownerLease(8000));
    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 8000 },
      portUsage: portUsage([{ pid: 9000, commandLine: "openclaw-gateway" }]),
    });
    expect(snapshot.healthy).toBe(false);
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("verifies a healthy gateway listener child pid without marking it stale", async () => {
    callGateway.mockImplementation(gatewayHealthResponse());
    const snapshot = await inspectGatewayRestartWithSnapshot({
      runtime: { status: "running", pid: 7000 },
      portUsage: portUsage([{ pid: 7001, ppid: 7000, commandLine: "openclaw-gateway" }]),
    });

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.staleGatewayPids).toStrictEqual([]);
    expect(inspectPortUsage).toHaveBeenCalledWith(18789, {
      probeHosts: ["127.0.0.1"],
    });
  });

  it("does not classify an unknown Windows listener as stale when runtime is running", async () => {
    const snapshot = await inspectUnknownListener({ runtime: { status: "running", pid: 10920 } });
    expect(snapshot.staleGatewayPids).toEqual([]);
  });

  it("treats a correlated Gateway scope rejection as healthy gateway reachability", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe(
      gatewayResponseError(
        "pairing required: device is asking for more scopes than currently approved",
      ),
    );

    expect(snapshot.healthy).toBe(true);
    expect(snapshot.probeError).toBeUndefined();
  });

  it("does not treat an ambiguous 1008 pairing close as healthy gateway reachability", async () => {
    const snapshot = await inspectAmbiguousOwnershipWithProbe(
      new Error("gateway closed (1008): pairing required"),
    );

    expect(snapshot.healthy).toBe(false);
  });

  it("does not verify a busy port with unavailable listener details when health fails", async () => {
    const service = {
      readRuntime: vi.fn(async () => ({ status: "running", pid: 8000 })),
    } as unknown as GatewayService;

    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [],
      hints: [
        "Port is in use but process details are unavailable (install lsof or run as an admin user).",
      ],
      errors: ["Error: spawn lsof ENOENT"],
    });

    const { inspectGatewayRestart } = await import("./restart-health.js");
    const snapshot = await inspectGatewayRestart({ service, port: 18789 });

    expect(snapshot.healthy).toBe(false);
    expect(snapshot.probeError).toContain("ECONNREFUSED");
    expect(resolveGatewayServiceProbeHosts).toHaveBeenCalledWith({
      env: process.env,
      command: null,
    });
  });
  it("waits for managed startup after an initially unhealthy foreign listener", async () => {
    const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
    const service = makeGatewayService({ status: "running", pid: 8000 });
    vi.mocked(service.readRuntime).mockResolvedValueOnce({ status: "stopped", missingUnit: true });
    inspectPortUsage.mockResolvedValue(portUsage([{ pid: 8000, command: "socat" }]));
    classifyPortListener.mockImplementation(() =>
      monotonicClock.nowMs === 0 ? "non_gateway" : "gateway",
    );
    callGateway.mockImplementation(gatewayHealthResponse());
    callGateway.mockRejectedValueOnce(new Error("connect ECONNRESET"));

    const snapshot = await waitForGatewayHealthyRestart({
      service,
      port: 18789,
      requireRunningService: true,
      attempts: 3,
      delayMs: 500,
    });

    expect(snapshot).toMatchObject({
      healthy: true,
      waitOutcome: "healthy",
      runtime: { status: "running", pid: 8000 },
      elapsedMs: 500,
    });
  });
});
