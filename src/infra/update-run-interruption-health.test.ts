import { afterEach, expect, it, vi } from "vitest";
import type { MockedFunction } from "vitest";
import type { waitForGatewayHealthyRestart } from "../cli/daemon-cli/restart-health.js";
import type { GatewayRestartSnapshot } from "../cli/daemon-cli/restart-health.types.js";

type WaitForHealthySignature = (
  params: Parameters<typeof waitForGatewayHealthyRestart>[0],
) => Promise<GatewayRestartSnapshot>;

const mockWaitForHealthy = vi.fn(async () => ({
  healthy: true,
  runtime: { status: "running", pid: 1 },
  portUsage: { status: "listening", pid: 1 },
  staleGatewayPids: [],
  gatewayVersion: "1.0.0",
  gatewayBuildId: "b1",
  waitOutcome: "healthy" as const,
  elapsedMs: 0,
})) as unknown as MockedFunction<WaitForHealthySignature>;

const httpState = vi.hoisted(() => ({ healthz: 200, readyz: 200 }));
vi.mock("../cli/daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ auth: undefined, config: {} }),
  waitForGatewayHttpReadiness: async () => ({
    healthz: httpState.healthz,
    readyz: httpState.readyz,
  }),
  confirmGatewayReachable: async () => ({ reachable: true }),
}));
vi.mock("../cli/daemon-cli/restart-health.js", () => ({
  inspectGatewayRestart: async () => ({
    healthy: true,
    runtime: { status: "running", pid: 1 },
    gatewayVersion: "1.0.0",
    gatewayBuildId: "b1",
  }),
  isSameGatewayRestartGeneration: () => true,
  waitForGatewayHealthyRestart: (params: Parameters<typeof waitForGatewayHealthyRestart>[0]) =>
    mockWaitForHealthy(params),
}));
vi.mock("../config/paths.js", () => ({ resolveGatewayPort: () => 18789 }));
vi.mock("./openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: async () => "/fake/root",
}));
vi.mock("./package-json.js", () => ({ readPackageVersion: async () => "1.0.0" }));
vi.mock("./update-git-runtime.js", () => ({ readBuiltGatewayBuildId: async () => "b1" }));

const { observeInterruptedUpdateGateway } = await import("./update-run-interruption-health.js");

const candidate = { version: "1.0.0", buildId: "b1" };

afterEach(() => {
  vi.resetAllMocks();
});

it("proceeds to the probe and returns verification when the managed service is healthy", async () => {
  const result = await observeInterruptedUpdateGateway(candidate, {});
  expect(result).toEqual({ verification: expect.any(Object), settleBudgetExceeded: false });
  expect(mockWaitForHealthy).toHaveBeenCalledTimes(1);
});

it("reports settleBudgetExceeded when the managed service probe fails to verify", async () => {
  mockWaitForHealthy.mockResolvedValueOnce({
    healthy: false,
    runtime: { status: "running", pid: 12345 },
    portUsage: { status: "busy", port: 18789, listeners: [], hints: [] },
    staleGatewayPids: [],
    gatewayVersion: undefined,
    gatewayBuildId: undefined,
    waitOutcome: "timeout" as const,
    elapsedMs: 5_000,
  });
  const result = await observeInterruptedUpdateGateway(candidate, {});
  expect(result).toEqual({ verification: undefined, settleBudgetExceeded: true });
});

it("proceeds to the probe with a bounded timeoutMs derived from restart-health constants", async () => {
  const result = await observeInterruptedUpdateGateway(candidate, {});
  expect(result).toEqual({ verification: expect.any(Object), settleBudgetExceeded: false });
  expect(mockWaitForHealthy).toHaveBeenCalledTimes(1);
  expect(mockWaitForHealthy.mock.calls[0]?.[0].timeoutMs).toBe(15_000);
  expect(mockWaitForHealthy.mock.calls[0]?.[0].requireRunningService).toBe(true);
  expect(mockWaitForHealthy.mock.calls[0]?.[0].settle?.probes).toBe(12);
});

it("reports settleBudgetExceeded when HTTP readiness fails after a healthy settle", async () => {
  httpState.healthz = 503;
  httpState.readyz = 503;
  const result = await observeInterruptedUpdateGateway(candidate, {});
  expect(result).toEqual({ verification: undefined, settleBudgetExceeded: true });
  httpState.healthz = 200;
  httpState.readyz = 200;
});

it("keeps a managed run eligible even when settle returns unhealthy", async () => {
  // Guards steipete's Finding 1: a managed run must NOT be permanently excluded
  // just because the probe currently fails. The settleBudgetExceeded outcome
  // keeps the run retryable (verified at the reconciler level in the watcher test).
  mockWaitForHealthy.mockResolvedValueOnce({
    healthy: false,
    runtime: { status: "stopped" },
    portUsage: { status: "free" },
    staleGatewayPids: [],
    gatewayVersion: undefined,
    gatewayBuildId: undefined,
    waitOutcome: "timeout" as const,
    elapsedMs: 15_000,
  });
  const result = await observeInterruptedUpdateGateway(candidate, {});
  expect(result).toEqual({ verification: undefined, settleBudgetExceeded: true });
  expect(result).not.toHaveProperty("unmanaged");
});
