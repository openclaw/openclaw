import type { SystemInfoResult } from "../../../packages/gateway-protocol/src/index.js";
import type { SparklineSample } from "./sparkline-tile.tsx";

export type GatewayStatusSnapshot = {
  eventLoop?: Partial<NonNullable<SystemInfoResult["eventLoop"]>>;
  processMemory?: SystemInfoResult["processMemory"];
};

export type GatewayStatusSample<T extends GatewayStatusSnapshot = GatewayStatusSnapshot> = {
  at: number;
  status: T;
};

export function collectGatewayStatusSamples<T extends GatewayStatusSnapshot>(
  history: readonly GatewayStatusSample<T>[],
  read: (status: T) => number | Omit<SparklineSample, "at"> | undefined,
): SparklineSample[] {
  const samples: SparklineSample[] = [];
  for (const entry of history) {
    const reading = read(entry.status);
    const sample = typeof reading === "number" ? { value: reading } : reading;
    if (sample && Number.isFinite(sample.value)) {
      samples.push({ ...sample, at: entry.at });
    } else {
      samples.length = 0;
    }
  }
  return samples;
}
