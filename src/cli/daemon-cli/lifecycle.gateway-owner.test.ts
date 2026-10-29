import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import {
  lifecycleTestRuntime,
  lifecycleRuntimeLogs,
  resetLifecycleRuntimeLogs,
  resetLifecycleServiceMocks,
  service,
  stubEmptyGatewayEnv,
} from "./test-helpers/lifecycle-core-harness.js";

const owner = vi.hoisted(() => ({
  owner: "foreground-generation",
  pid: 9472,
  host: "fixture-host",
  startedAt: 100,
  port: 18789,
  mode: "foreground" as const,
  supervisor: null,
  state: "live" as const,
  expired: false,
}));
const mocks = vi.hoisted(() => ({
  readOwner: vi.fn<(params?: { env?: NodeJS.ProcessEnv }) => typeof owner | undefined>(() => owner),
  readLock: vi.fn<typeof import("../../infra/gateway-lock.js").readActiveGatewayLockIdentity>(),
  probeGateway: vi.fn(async () => ({
    ok: true,
    configSnapshot: { commands: { restart: true } },
  })),
  writeIntent: vi.fn(() => true),
  clearIntent: vi.fn(),
  signalPid: vi.fn(),
  callGatewayCli: vi.fn(async () => ({ pid: owner.pid })),
  waitForGatewayHealthyListener: vi.fn(async () => ({ healthy: true })),
}));
const lock = {
  ownerId: owner.owner,
  pid: owner.pid,
  port: owner.port,
  createdAt: "2026-09-13T02:27:25Z",
  startTime: owner.startedAt,
};
const command = {
  programArguments: [
    "node",
    "C:\\OpenClaw\\dist\\index.js",
    "gateway",
    "--port",
    "18789",
    "--task-supervisor",
  ],
  environment: {},
};

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: lifecycleTestRuntime,
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => service,
}));
vi.mock("../../config/config.js", async (original) => ({
  ...(await original<typeof import("../../config/config.js")>()),
  readBestEffortConfig: async () => ({ gateway: { port: 18789 } }),
}));
vi.mock("../../config/io.js", () => ({
  createConfigIO: () => ({
    readBestEffortConfig: async () => ({ gateway: { port: 18789 } }),
  }),
}));
vi.mock("./lifecycle-action-preflight.js", () => ({
  getServiceActionPreflightFailure: async () => null,
}));
vi.mock("../../infra/gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: mocks.readOwner,
}));
vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockPort: async () => owner.port,
  readActiveGatewayLockIdentity: mocks.readLock,
  isSameGatewayLockIdentity: (a: { ownerId?: string }, b: { ownerId?: string }) =>
    a.ownerId === b.ownerId,
}));
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: () => [owner.pid],
  signalVerifiedGatewayPidSync: mocks.signalPid,
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
}));
vi.mock("../../gateway/probe.js", () => ({
  probeGateway: mocks.probeGateway,
}));
vi.mock("../../gateway/call.js", () => ({ callGatewayCli: mocks.callGatewayCli }));
vi.mock("./restart-health.js", async (original) => ({
  ...(await original<typeof import("./restart-health.js")>()),
  waitForGatewayHealthyListener: mocks.waitForGatewayHealthyListener,
}));
vi.mock("./lifecycle-audit.js", () => ({
  appendGatewayLifecycleAudit: vi.fn(),
  createGatewayLifecycleMutationAudit: () => undefined,
  createServiceLifecycleMutationAudit: () => undefined,
  appendServiceLifecycleRepairAudit: vi.fn(),
}));
vi.mock("../../infra/restart-intent.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-intent.js")>()),
  prepareGatewayRestartIntentLegacyProcess: async () => undefined,
  writeGatewayRestartIntentSync: mocks.writeIntent,
  writeGatewayServiceRestartIntentSync: () => true,
  clearGatewayRestartIntentSync: mocks.clearIntent,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetLifecycleRuntimeLogs();
  resetLifecycleServiceMocks();
  stubEmptyGatewayEnv();
  mockSystemAccountHome();
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
  mocks.readOwner.mockImplementation((params) =>
    params?.env?.OPENCLAW_STATE_DIR === "foreign-service-state" ? undefined : owner,
  );
  mocks.readLock.mockReset().mockResolvedValue(lock);
  mocks.probeGateway.mockReset().mockResolvedValue({
    ok: true,
    configSnapshot: { commands: { restart: true } },
  });
  mocks.writeIntent.mockReset().mockReturnValue(true);
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  service.readCommand.mockResolvedValue(command);
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  service.restart.mockRejectedValue(new Error("gateway port 18789 is still busy before restart"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function expectChangedOwnerRefusal() {
  const { signalGatewayRestart } = await import("./lifecycle-unmanaged.js");
  await expect(
    signalGatewayRestart(owner.port, {
      enforceRestartConfig: true,
      processLabel: "unmanaged",
      auditSource: "cli",
    }),
  ).rejects.toThrow("gateway lock owner changed");
  expect(mocks.signalPid).not.toHaveBeenCalled();
  expect(mocks.callGatewayCli).not.toHaveBeenCalled();
}

it("does not restart a replacement owner discovered during the config probe", async () => {
  mocks.probeGateway.mockImplementationOnce(async () => {
    mocks.readLock.mockResolvedValue({ ...lock, ownerId: "replacement-owner" });
    return { ok: true, configSnapshot: { commands: { restart: true } } };
  });

  await expectChangedOwnerRefusal();
  expect(mocks.writeIntent).not.toHaveBeenCalled();
});

it("does not send a legacy restart signal when an owner ID appears at intent write", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  mocks.readLock.mockResolvedValue({ ...lock, ownerId: undefined });
  mocks.writeIntent.mockImplementationOnce(() => {
    mocks.readLock.mockResolvedValue({ ...lock, ownerId: "replacement-owner" });
    return true;
  });

  await expectChangedOwnerRefusal();
  expect(mocks.writeIntent).toHaveBeenCalledOnce();
  expect(mocks.clearIntent).toHaveBeenCalledOnce();
});

it("restarts the selected foreground owner before reporting healthy recovery", async () => {
  service.readCommand.mockResolvedValue({
    ...command,
    environment: { OPENCLAW_STATE_DIR: "foreign-service-state" },
  });
  const { runDaemonRestart } = await import("./lifecycle.js");
  await expect(runDaemonRestart({ json: true })).resolves.toBe(true);
  expect(lifecycleRuntimeLogs).toHaveLength(1);
  expect(JSON.parse(lifecycleRuntimeLogs[0]!)).toMatchObject({
    ok: true,
    result: "restarted",
  });
  expect(mocks.callGatewayCli).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "gateway.restart.request",
      params: expect.objectContaining({
        target: { pid: owner.pid, ownerId: owner.owner, port: owner.port },
      }),
    }),
  );
  expect(service.restart).not.toHaveBeenCalled();
  expect(service.install).not.toHaveBeenCalled();
  expect(mocks.callGatewayCli).toHaveBeenCalledOnce();
  expect(mocks.waitForGatewayHealthyListener).toHaveBeenCalledTimes(2);
  expect(mocks.waitForGatewayHealthyListener).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      port: owner.port,
      previousLockIdentity: lock,
    }),
  );
  const [before, after] = mocks.waitForGatewayHealthyListener.mock.invocationCallOrder;
  const request = mocks.callGatewayCli.mock.invocationCallOrder[0]!;
  expect(before).toBeLessThan(request);
  expect(request).toBeLessThan(after!);
  expect(after).toBeLessThan(lifecycleTestRuntime.writeJson.mock.invocationCallOrder[0]!);
});
