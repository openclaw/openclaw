import { vi } from "vitest";
import {
  GatewayProtocolRequestError,
  retainGatewayResponsePayload,
} from "../../../packages/gateway-client/src/protocol-request.js";
import type { GatewayService } from "../../daemon/service.js";
import type { CallGatewayOptions } from "../../gateway/call.js";
import { gatewayHealthResponse } from "../../gateway/health-response.test-support.js";
import type { ConfiguredGatewayLocalProbe } from "../../gateway/local-http-probe.js";
import type { GatewayLockIdentity } from "../../infra/gateway-lock.js";
import type { PortUsage } from "../../infra/ports-types.js";

type PortListenerKind = ReturnType<
  typeof import("../../infra/ports-format.js").classifyPortListener
>;

export const inspectPortUsage =
  vi.fn<(port: number, options?: { probeHosts?: readonly string[] }) => Promise<PortUsage>>();
export const monotonicClock = { nowMs: 0 };
export const sleep = vi.fn(async (ms: number) => {
  monotonicClock.nowMs += ms;
});
export const classifyPortListener = vi.fn<(_listener: unknown, _port: number) => PortListenerKind>(
  () => "gateway",
);
export const callGateway = vi.fn<(opts: CallGatewayOptions) => Promise<unknown>>();

export function gatewayResponseError(message: string): GatewayProtocolRequestError {
  const error = new GatewayProtocolRequestError({ code: "UNAVAILABLE", message });
  retainGatewayResponsePayload(error, undefined);
  return error;
}
export const requestStartupProbe = vi.fn<ConfiguredGatewayLocalProbe["requestHttp"]>();

vi.mock("../../gateway/local-http-probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../gateway/local-http-probe.js")>();
  return {
    ...actual,
    createConfiguredGatewayLocalProbe: (
      ...args: Parameters<typeof actual.createConfiguredGatewayLocalProbe>
    ) => {
      const probe = actual.createConfiguredGatewayLocalProbe(...args);
      return {
        ...probe,
        requestHttp: (params: Parameters<ConfiguredGatewayLocalProbe["requestHttp"]>[0]) =>
          params.pathname === "/startupz" ? requestStartupProbe(params) : probe.requestHttp(params),
      };
    },
  };
});

export const createConfigIO = vi.fn();
export const readBestEffortConfig = vi.fn(async () => ({}));
export const resolveGatewayProbeAuthSafeWithSecretInputs = vi.fn<
  (_opts: unknown) => Promise<{ auth: { token?: string; password?: string } }>
>(async () => ({ auth: {} }));
const hasActiveStartupMigrationLease = vi.fn<(_params?: unknown) => boolean>(() => false);

export function createStartupMigrationActivityProbe(isActive: () => boolean) {
  return vi.fn<
    typeof import("../../infra/startup-migration-checkpoint.js").hasActiveStartupMigrationLease
  >((params) => {
    const active = isActive();
    if (active) {
      params?.onActivity?.({
        owner: "migration-owner",
        pid: 8000,
        heartbeatAt: monotonicClock.nowMs,
      });
    }
    return active;
  });
}
export const readActiveGatewayLockIdentity = vi.fn();
export const readGatewayOwnerLease =
  vi.fn<typeof import("../../infra/gateway-owner-lease.js").readGatewayOwnerLease>();
export const resolveGatewayServiceProbeHosts = vi.fn<
  (_params?: unknown) => Promise<readonly string[]>
>(async () => ["127.0.0.1"]);

vi.mock("../../infra/ports-format.js", () => ({
  classifyPortListener: (listener: unknown, port: number) => classifyPortListener(listener, port),
  formatPortDiagnostics: vi.fn(() => []),
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: (port: number, options?: { probeHosts?: readonly string[] }) =>
    inspectPortUsage(port, options),
}));

vi.mock("../../infra/ports-probe.js", () => ({
  LOOPBACK_PORT_PROBE_HOSTS: ["127.0.0.1"],
}));

vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: (opts: CallGatewayOptions) => callGateway(opts),
}));

vi.mock("../../config/io.js", () => ({
  createConfigIO: (opts: unknown) => createConfigIO(opts),
}));

vi.mock("../../gateway/probe-auth.js", () => ({
  resolveGatewayProbeAuthSafeWithSecretInputs: (opts: unknown) =>
    resolveGatewayProbeAuthSafeWithSecretInputs(opts),
}));

vi.mock("../../infra/startup-migration-checkpoint.js", () => ({
  hasActiveStartupMigrationLease: (params: unknown) => hasActiveStartupMigrationLease(params),
  STARTUP_MIGRATION_LEASE_TTL_MS: 5 * 60_000,
  STARTUP_MIGRATION_HEARTBEAT_INTERVAL_MS: 60_000,
}));

vi.mock("../../infra/gateway-owner-lease.js", () => ({
  readGatewayOwnerLease: (params: { env?: NodeJS.ProcessEnv; port?: number }) =>
    readGatewayOwnerLease(params),
}));

vi.mock("../../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: (params?: { env?: NodeJS.ProcessEnv }) =>
    readActiveGatewayLockIdentity(params),
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

vi.mock("../../daemon/gateway-service-probe-hosts.js", () => ({
  resolveGatewayServiceProbeHosts: (params: unknown) => resolveGatewayServiceProbeHosts(params),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    sleep: (ms: number) => sleep(ms),
  };
});

const originalPlatform = process.platform;

export function makeGatewayService(
  runtime: { status: "running"; pid: number } | { status: "stopped" },
): GatewayService {
  return {
    readRuntime: vi.fn(async () => runtime),
    readCommand: vi.fn(async () => null),
  } as unknown as GatewayService;
}

export function firstCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0];
}

const previousGatewayLockIdentity: GatewayLockIdentity = {
  pid: 4200,
  ownerId: "gateway-owner-old",
  createdAt: "2026-07-16T12:00:00.000Z",
  port: 18789,
};

export function mockGatewayLockReplacement(overrides: Partial<GatewayLockIdentity> = {}) {
  const previousLockIdentity = { ...previousGatewayLockIdentity };
  readActiveGatewayLockIdentity.mockResolvedValueOnce(previousLockIdentity).mockResolvedValue({
    ...previousLockIdentity,
    ownerId: "gateway-owner-new",
    createdAt: "2026-07-16T12:00:01.000Z",
    ...overrides,
  });
  return previousLockIdentity;
}

export async function inspectGatewayRestartWithSnapshot(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
  portUsage: PortUsage;
  expectedVersion?: string;
  expectedBuildId?: string;
}) {
  const service = makeGatewayService(params.runtime);
  inspectPortUsage.mockResolvedValue(params.portUsage);
  const { inspectGatewayRestart } = await import("./restart-health.js");
  return inspectGatewayRestart({
    service,
    port: 18789,
    probeHosts: ["127.0.0.1"],
    ...(params.expectedVersion === undefined ? {} : { expectedVersion: params.expectedVersion }),
    ...(params.expectedBuildId === undefined ? {} : { expectedBuildId: params.expectedBuildId }),
  });
}

export async function inspectUnknownListener(params: {
  runtime: { status: "running"; pid: number } | { status: "stopped" };
}) {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  classifyPortListener.mockReturnValue("unknown");
  return inspectGatewayRestartWithSnapshot({
    runtime: params.runtime,
    portUsage: {
      port: 18789,
      status: "busy",
      listeners: [{ pid: 10920, command: "unknown" }],
      hints: [],
    },
  });
}

export async function inspectAmbiguousOwnershipWithProbe(error?: Error) {
  classifyPortListener.mockReturnValue("unknown");
  if (error) {
    callGateway.mockRejectedValue(error);
  } else {
    callGateway.mockImplementation(gatewayHealthResponse());
  }
  return inspectGatewayRestartWithSnapshot({
    runtime: { status: "running", pid: 8000 },
    portUsage: {
      port: 18789,
      status: "busy",
      listeners: [{ commandLine: "" }],
      hints: [],
    },
  });
}

export async function waitForStoppedFreeGatewayRestart(
  params: {
    supervisorKeepsAlive?: boolean;
  } = {},
) {
  const attempts = process.platform === "win32" ? 360 : 120;
  const service = makeGatewayService({ status: "stopped" });
  inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "free",
    listeners: [],
    hints: [],
  });

  const { waitForGatewayHealthyRestart } = await import("./restart-health.js");
  return waitForGatewayHealthyRestart({
    service,
    port: 18789,
    attempts,
    delayMs: 500,
    supervisorKeepsAlive: params.supervisorKeepsAlive,
  });
}

export function resetRestartHealthMocks() {
  requestStartupProbe.mockReset();
  requestStartupProbe.mockResolvedValue(null);
  monotonicClock.nowMs = 0;
  vi.spyOn(performance, "now").mockImplementation(() => monotonicClock.nowMs);
  inspectPortUsage.mockReset();
  readBestEffortConfig.mockReset();
  // These transport-mocked lifecycle tests spoof OS state; they must not load
  // native credential storage under a platform different from the running host.
  readBestEffortConfig.mockResolvedValue({ gateway: { auth: { mode: "none" } } });
  createConfigIO.mockReset();
  createConfigIO.mockReturnValue({
    readBestEffortConfig: () => readBestEffortConfig(),
  });
  resolveGatewayProbeAuthSafeWithSecretInputs.mockReset();
  resolveGatewayProbeAuthSafeWithSecretInputs.mockResolvedValue({ auth: {} });
  inspectPortUsage.mockResolvedValue({
    port: 0,
    status: "free",
    listeners: [],
    hints: [],
  });
  sleep.mockReset();
  sleep.mockImplementation(async (ms: number) => {
    monotonicClock.nowMs += ms;
  });
  classifyPortListener.mockReset();
  classifyPortListener.mockReturnValue("gateway");
  callGateway.mockReset();
  callGateway.mockRejectedValue(new Error("connect ECONNREFUSED"));
  hasActiveStartupMigrationLease.mockReset();
  hasActiveStartupMigrationLease.mockReturnValue(false);
  readActiveGatewayLockIdentity.mockReset();
  readActiveGatewayLockIdentity.mockResolvedValue(undefined);
  readGatewayOwnerLease.mockReset();
  readGatewayOwnerLease.mockReturnValue(undefined);
  resolveGatewayServiceProbeHosts.mockReset();
  resolveGatewayServiceProbeHosts.mockResolvedValue(["127.0.0.1"]);
}

export function restoreRestartHealthMocks() {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
}
