import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayServiceUpdateAuthority } from "../../daemon/service-update-authority.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { GatewayOwnerLeaseIdentity } from "../../infra/gateway-owner-lease.js";
import { captureEnv } from "../../test-utils/env.js";
import {
  lifecycleTestRuntime,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
} from "./test-helpers/lifecycle-core-harness.js";

const selectedPort = 19_001;
const foreignPort = 19_002;
const config = { gateway: { port: selectedPort } };
const selectedLock: GatewayLockIdentity = {
  pid: 4200,
  port: 19_003,
  ownerId: "isolated-owner",
  createdAt: "2026-07-16T12:00:00.000Z",
};
const selectedLease: GatewayOwnerLeaseIdentity = {
  pid: 4200,
  host: "test-host",
  startedAt: 123,
  owner: "isolated-owner",
  port: 19_003,
  mode: "foreground",
  supervisor: null,
  state: "live",
  expired: false,
};
const readActiveGatewayLockIdentity =
  vi.fn<typeof import("../../infra/gateway-lock.js").readActiveGatewayLockIdentity>();
const readGatewayOwnerLease =
  vi.fn<typeof import("../../infra/gateway-owner-lease.js").readGatewayOwnerLease>();
const findVerifiedGatewayListenerPidsOnPortSync = vi.fn();
const signalVerifiedGatewayPidSync = vi.fn();
const findInstalledSystemdGatewayScope = vi.fn();
const stopSystemdService = vi.fn();
const appendGatewayLifecycleAudit = vi.fn();

vi.mock("../../runtime.js", () => ({ defaultRuntime: lifecycleTestRuntime }));
vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => config,
  loadConfig: () => config,
  readBestEffortConfig: async () => config,
  resolveGatewayPort: () => selectedPort,
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: () => ({ readBestEffortConfig: async () => config }),
}));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));
vi.mock("../../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/systemd.js")>()),
  findInstalledSystemdGatewayScope: () => findInstalledSystemdGatewayScope(),
  stopSystemdService: () => stopSystemdService(),
}));
vi.mock("../../infra/gateway-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-lock.js")>()),
  readActiveGatewayLockIdentity,
}));
vi.mock("../../infra/gateway-owner-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/gateway-owner-lease.js")>()),
  readGatewayOwnerLease,
}));
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: (port: number) =>
    findVerifiedGatewayListenerPidsOnPortSync(port),
  signalVerifiedGatewayPidSync: (pid: number, signal: string) =>
    signalVerifiedGatewayPidSync(pid, signal),
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
}));
vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: async () => ["127.0.0.1"],
}));
vi.mock("../../infra/ports-probe.js", () => ({ probePortUsage: async () => "free" }));
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));
vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: (event: unknown) => appendGatewayLifecycleAudit(event),
  createGatewayLifecycleMutationAudit: () => vi.fn(),
  createServiceLifecycleMutationAudit: () => vi.fn(),
  appendServiceLifecycleRepairAudit: vi.fn(),
}));

const { runDaemonStop } = await import("./lifecycle.js");
const stopOptions = { json: true, force: true };

describe("isolated Gateway stop ownership", () => {
  let environment: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    environment = captureEnv([
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_PROFILE",
      "OPENCLAW_SUPERVISOR_MODE",
    ]);
    delete process.env.OPENCLAW_PROFILE;
    delete process.env.OPENCLAW_SUPERVISOR_MODE;
    process.env.OPENCLAW_STATE_DIR = "/tmp/openclaw-non-default-service-state";
    vi.clearAllMocks();
    mockSystemAccountHome();
    resetLifecycleRuntimeLogs();
    resetLifecycleServiceMocks();
    service.isLoaded.mockResolvedValue(false);
    readActiveGatewayLockIdentity.mockReset().mockResolvedValue({ ...selectedLock });
    readGatewayOwnerLease
      .mockReset()
      .mockImplementation((options) => (options?.current ? { ...selectedLease } : undefined));
    findVerifiedGatewayListenerPidsOnPortSync.mockReset().mockReturnValue([4200]);
    signalVerifiedGatewayPidSync.mockReset();
    findInstalledSystemdGatewayScope.mockReset().mockResolvedValue(null);
    stopSystemdService.mockReset();
  });

  afterEach(() => {
    environment.restore();
    vi.restoreAllMocks();
  });

  async function expectReportedRefusal(message: string) {
    await expect(runDaemonStop(stopOptions)).rejects.toThrow("__exit__:1");
    expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: expect.stringContaining(message) }),
    );
    expect(signalVerifiedGatewayPidSync).not.toHaveBeenCalled();
    expect(service.stop).not.toHaveBeenCalled();
  }

  it.each([false, true])(
    "stops the live physical owner despite lease expiry=%s",
    async (expired) => {
      readGatewayOwnerLease.mockImplementation((options) =>
        options?.current ? { ...selectedLease, expired } : undefined,
      );
      await runDaemonStop(stopOptions);

      expect(findVerifiedGatewayListenerPidsOnPortSync).toHaveBeenCalledExactlyOnceWith(19_003);
      expect(signalVerifiedGatewayPidSync).toHaveBeenCalledExactlyOnceWith(4200, "SIGTERM");
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.readCommand).not.toHaveBeenCalled();
      expect(appendGatewayLifecycleAudit).toHaveBeenCalledWith({
        action: "stop",
        source: "cli",
        mode: "sigterm",
        pid: 4200,
      });
      expect(lifecycleTestRuntime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({ ok: true, result: "stopped" }),
      );
    },
  );

  it("refuses a port-only stop when the selected state has no Gateway lock", async () => {
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);
    service.readCommand.mockResolvedValue({
      programArguments: ["openclaw", "gateway", "--port", String(foreignPort)],
      environment: { OPENCLAW_STATE_DIR: "/foreign/service/state" },
    });
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([4300]);

    await expectReportedRefusal("non-default state dir");

    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
    expect(service.readCommand).not.toHaveBeenCalled();
  });

  it("refuses an unverifiable selected-state lock instead of using its configured port", async () => {
    readActiveGatewayLockIdentity.mockRejectedValue(new Error("Gateway lock inspection failed"));

    await expectReportedRefusal("Gateway lock inspection failed");

    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it.each([[4300], [4200, 4300]])(
    "refuses listeners that disagree with the locked PID: %j",
    async (...pids) => {
      findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue(pids);

      await expectReportedRefusal("selected-state lock owner");
    },
  );

  it.each([
    { name: "missing", current: undefined },
    { name: "replaced", current: { ...selectedLock, ownerId: "replacement-owner", pid: 4300 } },
    { name: "different port", current: { ...selectedLock, port: foreignPort } },
  ])("refuses a $name lock at final signal admission", async ({ current }) => {
    readActiveGatewayLockIdentity
      .mockResolvedValueOnce({ ...selectedLock })
      .mockResolvedValueOnce(current);

    await expectReportedRefusal("Gateway lock changed");
  });

  it.each([
    { name: "missing", owner: undefined },
    { name: "unknown", owner: { ...selectedLease, state: "unknown" } },
    { name: "dead", owner: { ...selectedLease, state: "dead" } },
    {
      name: "supervised",
      owner: {
        ...selectedLease,
        mode: "supervised",
        supervisor: { kind: "launchd", name: "ai.openclaw.fixture" },
      },
    },
    { name: "different instance", owner: { ...selectedLease, owner: "replacement-owner" } },
    { name: "different PID", owner: { ...selectedLease, pid: 4300 } },
    { name: "different port", owner: { ...selectedLease, port: foreignPort } },
  ] satisfies Array<{ name: string; owner: GatewayOwnerLeaseIdentity | undefined }>)(
    "refuses a $name foreground ownership record",
    async ({ owner }) => {
      readGatewayOwnerLease.mockReturnValue(owner);

      await expectReportedRefusal("foreground Gateway owner");
    },
  );

  it("retains the service refusal when no isolated Gateway is found", async () => {
    readActiveGatewayLockIdentity.mockResolvedValue(undefined);
    findVerifiedGatewayListenerPidsOnPortSync.mockReturnValue([]);

    await expectReportedRefusal("non-default state dir");
  });

  it.each([
    { loaded: true, disable: false },
    { loaded: false, disable: true },
  ])("refuses native mutation (loaded=$loaded, disable=$disable)", async ({ loaded, disable }) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    service.isLoaded.mockResolvedValue(loaded);

    await expect(runDaemonStop({ ...stopOptions, disable })).rejects.toThrow(
      /non-default state dir/,
    );

    expect(service.stop).not.toHaveBeenCalled();
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("refuses a disabled running systemd service before stopping it", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    service.readRuntime.mockResolvedValue({ status: "running" });

    await expectReportedRefusal("non-default state dir");

    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("refuses system-scope service mutation before unmanaged signaling", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });

    await expectReportedRefusal("non-default state dir");

    expect(stopSystemdService).not.toHaveBeenCalled();
    expect(findVerifiedGatewayListenerPidsOnPortSync).not.toHaveBeenCalled();
  });

  it("does not transfer updater authority into an unmanaged stop", async () => {
    await withGatewayServiceUpdateAuthority(
      () => {},
      () => expectReportedRefusal("UPDATE_NATIVE_AUTHORITY"),
    );

    expect(readActiveGatewayLockIdentity).not.toHaveBeenCalled();
  });
});
