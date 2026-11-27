import type { SystemInfoResult } from "@openclaw/gateway-protocol";
import type { SystemsInventoryRow } from "./systems-data.ts";

export const SYSTEMS_GATEWAY_STALE_MS = 30_000;
// Nodes publish once a minute; allow a missed report before marking their data stale.
export const SYSTEMS_NODE_STALE_MS = 120_000;

export type HostMeasurements = Pick<
  SystemInfoResult,
  | "cpuCount"
  | "loadAverage"
  | "memoryTotalBytes"
  | "memoryFreeBytes"
  | "diskTotalBytes"
  | "diskAvailableBytes"
  | "disks"
>;

export type SystemsTelemetrySample = {
  at: number;
  stats: HostMeasurements;
};

export function systemMeasurements(row: SystemsInventoryRow): HostMeasurements | undefined {
  return row.gatewaySystemInfo ?? row.node?.hostStats;
}
