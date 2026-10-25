import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  inspectPortUsage: vi.fn(),
  confirmGatewayReachable: vi.fn(),
  readGatewayStartupPhase: vi.fn(),
}));
// mock-isolation: Fixed loopback target avoids installed-service discovery.
vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));
// mock-isolation: Synthetic observations must not read the operator ownership database.
vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease: () => undefined }));
// mock-isolation: Supply Windows listener metadata without host process inspection.
vi.mock("../../infra/ports-inspect.js", () => ({ inspectPortUsage: mocks.inspectPortUsage }));
// mock-isolation: Control protocol results without contacting the operator Gateway.
vi.mock("./restart-health-probe.js", () => ({
  confirmGatewayReachable: mocks.confirmGatewayReachable,
  readGatewayStartupPhase: mocks.readGatewayStartupPhase,
}));
import { inspectGatewayRestart } from "./restart-health-inspect.js";

describe("read-only Windows diagnostics with unavailable process metadata", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    mocks.inspectPortUsage.mockReset().mockResolvedValue({
      port: 18889,
      status: "busy",
      listeners: [{ pid: 9000, command: "node.exe" }],
      hints: [],
    });
    mocks.readGatewayStartupPhase.mockReset().mockResolvedValue(undefined);
    mocks.confirmGatewayReachable.mockReset().mockResolvedValue({
      reachable: true,
      gatewayVersion: "fixture-version",
      gatewayBuildId: "fixture-build",
      gatewayBootId: "fixture-boot",
      activatedPluginErrors: [],
      unavailablePlugins: [],
      channelProbeErrors: [],
    });
  });

  it.each([
    { name: "successful hello and health", healthy: true, calls: 1 },
    { name: "ordinary restart keeps its default", flag: false, healthy: false, calls: 0 },
    { name: "non-Windows remains unchanged", platform: "linux", healthy: false, calls: 0 },
    {
      name: "known foreign runtime PID is not reattributed",
      runtimePid: 8000,
      healthy: false,
      calls: 0,
    },
    {
      name: "available foreign command line is not reattributed",
      commandLine: "foreign-service.exe",
      healthy: false,
      calls: 0,
    },
    {
      name: "classified non-gateway is not reattributed",
      command: "socat.exe",
      healthy: false,
      calls: 0,
    },
    {
      name: "empty listener list is not new evidence",
      noListeners: true,
      healthy: false,
      calls: 0,
    },
    {
      name: "auth rejection liveness is insufficient",
      reachability: { reachable: true, gatewayVersion: null },
      healthy: false,
      calls: 1,
    },
    {
      name: "transport failure is not healthy",
      reachability: { reachable: false, probeError: "connect failed" },
      healthy: false,
      calls: 1,
    },
    {
      name: "wrong version remains rejected",
      expectedVersion: "different-version",
      healthy: false,
      calls: 1,
    },
    {
      name: "wrong build remains rejected",
      expectedBuildId: "different-build",
      healthy: false,
      calls: 1,
    },
    {
      name: "channel failure remains rejected",
      reachability: { channelProbeErrors: [{ id: "fixture", error: "fixture failure" }] },
      healthy: false,
      calls: 1,
    },
    { name: "startup cannot be hidden", startup: true, healthy: false, calls: 0 },
  ] as const)("$name", async (scenario) => {
    if ("platform" in scenario && scenario.platform !== undefined) {
      vi.spyOn(process, "platform", "get").mockReturnValue(scenario.platform);
    }
    mocks.inspectPortUsage.mockResolvedValue({
      port: 18889,
      status: "busy",
      listeners:
        "noListeners" in scenario
          ? []
          : [
              {
                pid: 9000,
                command: "command" in scenario ? scenario.command : "node.exe",
                ...("commandLine" in scenario ? { commandLine: scenario.commandLine } : {}),
              },
            ],
      hints: [],
    });
    if ("startup" in scenario) {
      mocks.readGatewayStartupPhase.mockResolvedValue("plugin-convergence");
    }
    if ("reachability" in scenario) {
      mocks.confirmGatewayReachable.mockResolvedValue({
        ...(await mocks.confirmGatewayReachable()),
        ...scenario.reachability,
      });
    }
    mocks.confirmGatewayReachable.mockClear();
    const snapshot = await inspectGatewayRestart({
      service: {
        readCommand: async () => null,
        readRuntime: async () => ({
          status: "running",
          ...("runtimePid" in scenario ? { pid: scenario.runtimePid } : {}),
        }),
      },
      port: 18889,
      probeHosts: ["127.0.0.1"],
      probeContext: { config: {}, auth: { token: "synthetic-test-token" } },
      configuredProbe: {
        requestHttp: async () => null,
        resolveWebSocketTarget: async () => null,
      },
      requirePluginHealth: false,
      ...("flag" in scenario ? {} : { allowUnattributedDiagnosticProbe: true }),
      ...("expectedVersion" in scenario ? { expectedVersion: scenario.expectedVersion } : {}),
      ...("expectedBuildId" in scenario ? { expectedBuildId: scenario.expectedBuildId } : {}),
    });
    expect(snapshot.healthy).toBe(scenario.healthy);
    expect(mocks.confirmGatewayReachable).toHaveBeenCalledTimes(scenario.calls);
    expect(snapshot.runtime.pid).toBe("runtimePid" in scenario ? scenario.runtimePid : undefined);
    expect(snapshot.staleGatewayPids).toEqual([]);
    if (scenario.calls) {
      expect(mocks.confirmGatewayReachable).toHaveBeenCalledWith(
        expect.objectContaining({ port: 18889, auth: { token: "synthetic-test-token" } }),
      );
    }
    if ("expectedVersion" in scenario) {
      expect(snapshot.versionMismatch).toBeDefined();
    }
    if ("expectedBuildId" in scenario) {
      expect(snapshot.buildIdMismatch).toBeDefined();
    }
  });
});
