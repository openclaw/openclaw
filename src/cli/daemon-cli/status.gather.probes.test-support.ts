import { vi } from "vitest";
import type { PortListener, PortUsageStatus } from "../../infra/ports-types.js";
import { defaultRuntime } from "../../runtime.js";
import { printDaemonStatus } from "./status.print.js";

export function capturePrintedDaemonStatus(
  status: Parameters<typeof printDaemonStatus>[0],
  options: Parameters<typeof printDaemonStatus>[1],
): { logs: string; errors: string } {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  try {
    printDaemonStatus(status, options);
    return {
      logs: log.mock.calls.flat().join("\n"),
      errors: error.mock.calls.flat().join("\n"),
    };
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
}

type PortConnections = Awaited<
  ReturnType<typeof import("../../infra/ports-inspect.js").inspectPortConnections>
>;
export type GatewayStatusProbeOptions = Parameters<
  typeof import("./probe.js").probeGatewayStatus
>[0];

export const callGatewayStatusProbe = vi.fn<
  (opts: GatewayStatusProbeOptions) => Promise<{
    ok: boolean;
    url?: string;
    error?: string | null;
    server?: { version?: string | null; buildId?: string | null; connId?: string | null };
    version?: string | null;
  }>
>(async (_opts: GatewayStatusProbeOptions) => ({
  ok: true,
  url: "ws://127.0.0.1:19001",
  error: null,
  server: { version: "2026.5.6", buildId: "build-2026.5.6", connId: "conn-1" },
}));

export type PortUsageTestSummary = {
  port: number;
  status: PortUsageStatus;
  listeners: PortListener[];
  hints: string[];
};

export type PortUsageInspectionOptions = { probeHosts?: readonly string[] };

export const inspectPortUsage = vi.fn<
  (port: number, options?: PortUsageInspectionOptions) => Promise<PortUsageTestSummary>
>(async (port: number) => ({
  port,
  status: "free",
  listeners: [],
  hints: [],
}));

export const inspectPortUsages = vi.fn<
  (
    ports: readonly number[],
    options?: { probeHostsByPort?: ReadonlyMap<number, readonly string[]> },
  ) => Promise<Map<number, PortUsageTestSummary>>
>(
  async (ports) =>
    new Map(
      ports.map((port) => [
        port,
        {
          port,
          status: "free",
          listeners: [],
          hints: [],
        },
      ]),
    ),
);

export const inspectPortConnections = vi.fn<(port: number) => Promise<PortConnections>>(
  async (port: number) => ({
    port,
    connections: [],
  }),
);

export const formatPortDiagnostics = vi.fn<(usage: PortUsageTestSummary) => string[]>(() => []);
