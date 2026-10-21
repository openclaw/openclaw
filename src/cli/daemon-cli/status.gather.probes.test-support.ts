import { vi } from "vitest";
import type { GatewayServiceInventory } from "../../daemon/inspect.js";
import type { ForeignLaunchdJob } from "../../daemon/launchd-foreign-jobs.js";
import type { StaleOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import type { PortConnections, PortUsage } from "../../infra/ports-types.js";
import { defaultRuntime } from "../../runtime.js";
import type { probeGatewayStatus } from "./probe.js";
import { printDaemonStatus } from "./status.print.js";

export function capturePrintedDaemonStatus(...args: Parameters<typeof printDaemonStatus>) {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  try {
    printDaemonStatus(...args);
    return {
      logs: log.mock.calls.flat().join("\n"),
      errors: error.mock.calls.flat().join("\n"),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

export type GatewayStatusProbeOptions = Parameters<typeof probeGatewayStatus>[0];
export const callGatewayStatusProbe = vi.fn<
  (opts: GatewayStatusProbeOptions) => Promise<{
    ok: boolean;
    url?: string;
    error?: string | null;
    server?: { version?: string | null; buildId?: string | null; connId?: string | null };
    version?: string | null;
  }>
>(async (_opts) => ({
  ok: true,
  url: "ws://127.0.0.1:19001",
  error: null,
  server: { version: "2026.5.6", buildId: "build-2026.5.6", connId: "conn-1" },
}));

export type PortUsageTestSummary = Omit<PortUsage, "errors">;
export type PortUsageInspectionOptions = { probeHosts?: readonly string[] };

const freePort = (port: number): PortUsageTestSummary => ({
  port,
  status: "free",
  listeners: [],
  hints: [],
});
export const inspectPortUsage = vi.fn<
  (port: number, options?: PortUsageInspectionOptions) => Promise<PortUsageTestSummary>
>(async (port) => freePort(port));

export const inspectPortUsages = vi.fn<
  (
    ports: readonly number[],
    options?: { probeHostsByPort?: ReadonlyMap<number, readonly string[]> },
  ) => Promise<Map<number, PortUsageTestSummary>>
>(async (ports) => new Map(ports.map((port) => [port, freePort(port)])));

export const inspectPortConnections = vi.fn(async (port: number): Promise<PortConnections> => ({
  port,
  connections: [],
}));

export const formatPortDiagnostics = vi.fn<(usage: PortUsageTestSummary) => string[]>(() => []);

export const inspectGatewayTlsCertificate = vi.fn(async (_cfg?: unknown) => ({
  ok: true as const,
  value: { cert: "public-certificate", fingerprintSha256: "sha256:11:22:33:44" },
}));
export const findExtraGatewayServices = vi.fn<
  (_env?: unknown, _opts?: unknown) => Promise<GatewayServiceInventory>
>(async () => ({ services: [], errors: [] }));
export const findStaleOpenClawUpdateLaunchdJobs = vi.fn<
  (env?: NodeJS.ProcessEnv) => Promise<StaleOpenClawUpdateLaunchdJob[]>
>(async () => []);
export const findForeignLaunchdJobs = vi.fn<
  (env?: NodeJS.ProcessEnv) => Promise<ForeignLaunchdJob[]>
>(async () => []);
export const readLastGatewayErrorLine = vi.fn<(_env?: NodeJS.ProcessEnv) => Promise<string | null>>(
  async () => null,
);
