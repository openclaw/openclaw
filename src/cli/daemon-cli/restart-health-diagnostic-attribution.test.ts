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
import type { GatewayReachability } from "./restart-health-probe.js";

type Scenario = {
  name: string;
  healthy?: boolean;
  calls: number;
  flag?: boolean;
  platform?: NodeJS.Platform;
  runtimePid?: number;
  command?: string;
  commandLine?: string;
  noListeners?: boolean;
  startup?: boolean;
  reachability?: Partial<GatewayReachability>;
};
const reachable: GatewayReachability = {
  reachable: true,
  gatewayVersion: "fixture-version",
  gatewayBuildId: "fixture-build",
  activatedPluginErrors: [],
  unavailablePlugins: [],
  channelProbeErrors: [],
};

describe("read-only Windows diagnostics with unavailable process metadata", () => {
  afterEach(() => vi.restoreAllMocks());
  beforeEach(() => {
    mocks.inspectPortUsage.mockReset();
    mocks.readGatewayStartupPhase.mockReset().mockResolvedValue(undefined);
    mocks.confirmGatewayReachable.mockReset();
  });

  it.each<Scenario>([
    { name: "successful hello and health", healthy: true, calls: 1 },
    { name: "ordinary restart keeps its default", flag: false, calls: 0 },
    { name: "non-Windows remains unchanged", platform: "linux", calls: 0 },
    { name: "foreign runtime PID", runtimePid: 8000, calls: 0 },
    { name: "foreign command line", commandLine: "foreign-service.exe", calls: 0 },
    { name: "classified non-gateway", command: "socat.exe", calls: 0 },
    { name: "empty listener list", noListeners: true, calls: 0 },
    { name: "auth-only liveness", reachability: { gatewayVersion: null }, calls: 1 },
    { name: "startup cannot be hidden", startup: true, calls: 0 },
  ])("$name", async (scenario) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(scenario.platform ?? "win32");
    mocks.inspectPortUsage.mockResolvedValue({
      port: 18889,
      status: "busy",
      listeners: scenario.noListeners
        ? []
        : [
            {
              pid: 9000,
              command: scenario.command ?? "node.exe",
              commandLine: scenario.commandLine,
            },
          ],
      hints: [],
    });
    if (scenario.startup) {
      mocks.readGatewayStartupPhase.mockResolvedValue("plugin-convergence");
    }
    mocks.confirmGatewayReachable.mockResolvedValue({ ...reachable, ...scenario.reachability });
    const snapshot = await inspectGatewayRestart({
      service: {
        readCommand: async () => null,
        readRuntime: async () => ({ status: "running", pid: scenario.runtimePid }),
      },
      port: 18889,
      probeHosts: ["127.0.0.1"],
      probeContext: { config: {}, auth: { token: "synthetic-test-token" } },
      configuredProbe: {
        requestHttp: async () => null,
        resolveWebSocketTarget: async () => null,
      },
      requirePluginHealth: false,
      allowUnattributedDiagnosticProbe: scenario.flag === false ? undefined : true,
    });
    expect(snapshot).toMatchObject({
      healthy: scenario.healthy ?? false,
      runtime: { pid: scenario.runtimePid },
      staleGatewayPids: [],
    });
    expect(mocks.confirmGatewayReachable).toHaveBeenCalledTimes(scenario.calls);
  });
});
