import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommandProcessCleanupError } from "../../process/exec-result.js";

const service = {
  readCommand: vi.fn(),
  readRuntime: vi.fn(),
};
const runServiceRestart = vi.fn();
const runServiceStop = vi.fn();
const readActiveGatewayLockIdentity = vi.fn();
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn(
  (_port: number, _context?: { env?: NodeJS.ProcessEnv }): number[] => [],
);
const signalVerifiedGatewayPidSync = vi.fn();
const resolveGatewayPort = vi.fn(() => 18_789);
const readBestEffortConfig = vi.fn(async () => ({}));
const resolveGatewayServiceProbeHosts = vi.fn(async () => ["127.0.0.1"]);
const probePortUsage = vi.fn(async () => "free" as const);

vi.mock("../../config/config.js", () => ({
  readBestEffortConfig: () => readBestEffortConfig(),
  resolveGatewayPort: () => resolveGatewayPort(),
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: () => ({ readBestEffortConfig: () => readBestEffortConfig() }),
}));
vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts,
}));
vi.mock("../../daemon/service-update-authority.js", () => ({
  assertGatewayServiceFallbackAllowed: vi.fn(),
  assertGatewayServiceUpdateCurrent: vi.fn(),
}));
vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../daemon/systemd.js", () => ({
  findInstalledSystemdGatewayScope: vi.fn(async () => null),
  restartSystemdService: vi.fn(),
  stopSystemdService: vi.fn(),
}));
vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
  readActiveGatewayLockPort: vi.fn(async () => undefined),
}));
vi.mock("../../infra/gateway-owner-lease.js", () => ({ readGatewayOwnerLease: vi.fn() }));
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync,
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
  signalVerifiedGatewayPidSync,
}));
vi.mock("../../infra/gateway-supervision.js", () => ({
  assertGatewayServiceMutationAllowed: vi.fn(),
  formatExternalSupervisorActionRequired: vi.fn(),
  isGatewayExternallySupervised: vi.fn(() => false),
  resolveGatewayServiceMutationError: vi.fn(() => undefined),
}));
vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage }));
vi.mock("../../infra/restart.js", () => ({
  resolveGatewayRestartDeferralTimeoutMs: vi.fn(() => 0),
}));
vi.mock("../../gateway/call.js", () => ({ callGatewayCli: vi.fn() }));
vi.mock("../../gateway/probe.js", () => ({ probeGateway: vi.fn() }));
vi.mock("./launchd-recovery.js", () => ({ recoverInstalledLaunchAgent: vi.fn() }));
vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: vi.fn(),
  createGatewayLifecycleMutationAudit: vi.fn(() => vi.fn()),
}));
vi.mock("./lifecycle-core.js", () => ({
  runServiceRestart,
  runServiceStart: vi.fn(),
  runServiceStop,
  runServiceUninstall: vi.fn(),
}));
vi.mock("./lifecycle-safe-restart.js", () => ({
  resolveGatewayRestartIntentOptions: vi.fn(() => undefined),
  runSafeGatewayRestart: vi.fn(),
}));
vi.mock("./lifecycle-unmanaged.js", () => ({
  signalGatewayRestart: vi.fn(),
}));
vi.mock("./restart-health.js", () => ({
  DEFAULT_RESTART_HEALTH_ATTEMPTS: 120,
  DEFAULT_RESTART_HEALTH_DELAY_MS: 500,
  formatGatewayRestartFailure: vi.fn(),
  renderGatewayPortHealthDiagnostics: vi.fn(() => []),
  renderRestartDiagnostics: vi.fn(() => []),
  terminateStaleGatewayPids: vi.fn(),
  waitForGatewayHealthyListener: vi.fn(),
  waitForGatewayHealthyRestart: vi.fn(),
}));
vi.mock("./shared.js", () => ({ renderGatewayServiceStartHints: vi.fn(() => []) }));
vi.mock("./start-health.js", () => ({ verifyGatewayStartReadiness: vi.fn() }));
vi.mock("./start-repair.js", () => ({ repairLoadedGatewayServiceForStart: vi.fn() }));
vi.mock("../terminal-interactivity.js", () => ({
  isTerminalInteractive: vi.fn(() => true),
  NON_INTERACTIVE_GATEWAY_STOP_MESSAGE: "stop requires interaction",
}));

const { runDaemonRestart, runDaemonStop } = await import("./lifecycle.js");

describe("Gateway lifecycle fallback inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    service.readCommand.mockReset().mockResolvedValue(null);
    service.readRuntime.mockReset().mockResolvedValue({ status: "stopped" });
    readActiveGatewayLockIdentity.mockReset().mockResolvedValue(undefined);
  });

  it.each(["restart command", "stop command", "stop runtime"])(
    "does not fall back after uncertain %s cleanup",
    async (inspection) => {
      const platform =
        inspection === "stop runtime"
          ? vi.spyOn(process, "platform", "get").mockReturnValue("linux")
          : undefined;
      const cleanupError = new CommandProcessCleanupError();
      if (inspection === "stop runtime") {
        service.readRuntime.mockRejectedValueOnce(cleanupError);
      } else {
        service.readCommand.mockRejectedValueOnce(cleanupError);
      }
      if (inspection !== "restart command") {
        runServiceStop.mockImplementationOnce(
          async (params: {
            onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
          }) => await params.onNotLoaded?.({ stdout: process.stdout }),
        );
      }
      try {
        await expect(
          (inspection === "restart command" ? runDaemonRestart : runDaemonStop)({ json: true }),
        ).rejects.toBe(cleanupError);
        expect(runServiceRestart).not.toHaveBeenCalled();
        expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
        if (inspection === "stop runtime") {
          expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
          expect(service.readCommand).not.toHaveBeenCalled();
          expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
        }
      } finally {
        platform?.mockRestore();
      }
    },
  );

  it("keeps unmanaged stop fallback for ordinary command inspection failures", async () => {
    readActiveGatewayLockIdentity.mockResolvedValueOnce(undefined);
    service.readCommand.mockRejectedValueOnce(new Error("inspection failed"));
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValueOnce([4200]);
    runServiceStop.mockImplementationOnce(
      async (params: {
        onNotLoaded?: (ctx: { stdout: NodeJS.WritableStream }) => Promise<unknown>;
      }) => await params.onNotLoaded?.({ stdout: process.stdout }),
    );

    await expect(runDaemonStop({ json: true })).resolves.toEqual(
      expect.objectContaining({ result: "stopped" }),
    );

    expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledWith(18_789, {
      env: process.env,
    });
    expect(signalVerifiedGatewayPidSync).toHaveBeenCalledWith(4200, "SIGTERM", {
      env: process.env,
      port: 18_789,
    });
  });
});
