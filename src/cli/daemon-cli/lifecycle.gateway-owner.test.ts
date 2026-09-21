import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import {
  lifecycleTestRuntime,
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
  callGatewayCli: vi.fn(async () => ({ pid: owner.pid })),
  waitForGatewayHealthyListener: vi.fn(async () => ({ healthy: true })),
}));

vi.mock("../../runtime.js", () => ({ defaultRuntime: lifecycleTestRuntime }));
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
  readActiveGatewayLockIdentity: async () => ({
    ownerId: owner.owner,
    pid: owner.pid,
    port: owner.port,
    createdAt: "2026-09-13T02:27:25Z",
    startTime: owner.startedAt,
  }),
  isSameGatewayLockIdentity: (a: { ownerId?: string }, b: { ownerId?: string }) =>
    a.ownerId === b.ownerId,
}));
vi.mock("../../infra/gateway-processes.js", () => ({
  findVerifiedGatewayListenerPidsOnPortSync: () => [owner.pid],
  signalVerifiedGatewayPidSync: vi.fn(),
  formatGatewayPidList: (pids: number[]) => pids.join(", "),
}));
vi.mock("../../gateway/probe.js", () => ({
  probeGateway: async () => ({ ok: true, configSnapshot: { commands: { restart: true } } }),
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
  writeGatewayRestartIntentSync: () => true,
  writeGatewayServiceRestartIntentSync: () => true,
  clearGatewayRestartIntentSync: vi.fn(),
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
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  service.readCommand.mockResolvedValue({
    programArguments: [
      "node",
      "C:\\OpenClaw\\dist\\index.js",
      "gateway",
      "--port",
      "18789",
      "--task-supervisor",
    ],
    environment: {},
  });
  service.readRuntime.mockResolvedValue({ status: "stopped" });
  service.restart.mockRejectedValue(new Error("gateway port 18789 is still busy before restart"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([false, true])(
  "restarts the selected foreground owner despite an installed task (different state=%s)",
  async (differentState) => {
    if (differentState) {
      const command = await service.readCommand(process.env);
      if (!command) {
        throw new Error("Expected installed task fixture");
      }
      service.readCommand.mockResolvedValue({
        ...command,
        environment: { OPENCLAW_STATE_DIR: "foreign-service-state" },
      });
    }
    const { runDaemonRestart } = await import("./lifecycle.js");
    await expect(runDaemonRestart({ json: true })).resolves.toBe(true);
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
    expect(mocks.waitForGatewayHealthyListener).toHaveBeenCalled();
  },
);
