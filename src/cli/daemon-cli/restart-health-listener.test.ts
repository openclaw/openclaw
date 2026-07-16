// Listener-specific restart health tests cover gateway lock replacement behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PortUsage } from "../../infra/ports.js";

const inspectPortUsage = vi.hoisted(() => vi.fn<(port: number) => Promise<PortUsage>>());
const probeGateway = vi.hoisted(() => vi.fn());
const readActiveGatewayLockIdentity = vi.hoisted(() => vi.fn());
const sleep = vi.hoisted(() => vi.fn(async () => {}));
const readBestEffortConfig = vi.hoisted(() => vi.fn(async () => ({})));
const resolveGatewayProbeAuthSafeWithSecretInputs = vi.hoisted(() =>
  vi.fn(async () => ({ auth: {} })),
);

vi.mock("../../infra/ports.js", () => ({
  classifyPortListener: vi.fn(() => "gateway"),
  formatPortDiagnostics: vi.fn(() => []),
  inspectPortUsage: (port: number) => inspectPortUsage(port),
}));

vi.mock("../../gateway/probe.js", () => ({
  probeGateway: (opts: unknown) => probeGateway(opts),
}));

vi.mock("../../config/io.js", () => ({
  createConfigIO: vi.fn(() => ({
    readBestEffortConfig: () => readBestEffortConfig(),
  })),
}));

vi.mock("../../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafeWithSecretInputs: (opts: unknown) =>
    resolveGatewayProbeAuthSafeWithSecretInputs(opts),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: () => readActiveGatewayLockIdentity(),
  isSameGatewayLockIdentity: (
    previous: { ownerId?: string; pid: number; createdAt: string; startTime?: number },
    current: { ownerId?: string; pid: number; createdAt: string; startTime?: number },
  ) =>
    previous.ownerId && current.ownerId
      ? previous.ownerId === current.ownerId
      : previous.pid === current.pid &&
        previous.createdAt === current.createdAt &&
        previous.startTime === current.startTime,
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return { ...actual, sleep: (ms: number) => sleep(ms) };
});

const previousLockIdentity = {
  pid: 4200,
  ownerId: "gateway-owner-old",
  createdAt: "2026-07-16T12:00:00.000Z",
  port: 18789,
};

function mockReplacementLock(pid = 4200) {
  readActiveGatewayLockIdentity.mockResolvedValueOnce(previousLockIdentity).mockResolvedValue({
    ...previousLockIdentity,
    pid,
    ownerId: "gateway-owner-new",
    createdAt: "2026-07-16T12:00:01.000Z",
  });
}

describe("waitForGatewayHealthyListener", () => {
  beforeEach(() => {
    inspectPortUsage.mockReset();
    probeGateway.mockReset();
    readActiveGatewayLockIdentity.mockReset();
    sleep.mockReset();
    readBestEffortConfig.mockReset();
    readBestEffortConfig.mockResolvedValue({});
    resolveGatewayProbeAuthSafeWithSecretInputs.mockReset();
    resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({ auth: {} });
  });

  it("does not accept listener health until the gateway lock owner changes", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "busy",
      listeners: [{ pid: 4200, commandLine: "openclaw-gateway" }],
      hints: [],
    });
    probeGateway.mockResolvedValue({
      ok: true,
      close: null,
      server: { version: "2026.7.16", connId: "gateway" },
    });
    mockReplacementLock();

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      previousLockIdentity,
      attempts: 2,
      delayMs: 500,
    });

    expect(snapshot.healthy).toBe(true);
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
    expect(inspectPortUsage).toHaveBeenCalledTimes(1);
    expect(probeGateway).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it.each([
    { listenerPid: 4300, healthy: true },
    { listenerPid: 4400, healthy: false },
  ])(
    "accepts device identity policy close only for the verified replacement listener",
    async ({ listenerPid, healthy }) => {
      inspectPortUsage.mockResolvedValue({
        port: 18789,
        status: "busy",
        listeners: [{ pid: listenerPid, commandLine: "openclaw-gateway" }],
        hints: [],
      });
      probeGateway.mockResolvedValue({
        ok: false,
        close: { code: 1008, reason: "device identity required" },
      });
      mockReplacementLock(4300);

      const { waitForGatewayHealthyListener } = await import("./restart-health.js");
      const snapshot = await waitForGatewayHealthyListener({
        port: 18789,
        previousLockIdentity,
        attempts: 1,
        delayMs: 500,
      });

      expect(snapshot.healthy).toBe(healthy);
      expect(inspectPortUsage).toHaveBeenCalledTimes(1);
      expect(probeGateway).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds replacement health after an indefinite previous-owner wait", async () => {
    inspectPortUsage.mockResolvedValue({
      port: 18789,
      status: "free",
      listeners: [],
      hints: [],
    });
    mockReplacementLock();

    const { waitForGatewayHealthyListener } = await import("./restart-health.js");
    const snapshot = await waitForGatewayHealthyListener({
      port: 18789,
      previousLockIdentity,
      attempts: 2,
      delayMs: 500,
      waitIndefinitelyForPreviousOwner: true,
    });

    expect(snapshot.healthy).toBe(false);
    expect(readActiveGatewayLockIdentity).toHaveBeenCalledTimes(2);
    expect(inspectPortUsage).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
  });
});
