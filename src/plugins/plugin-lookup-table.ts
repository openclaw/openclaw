/** Builds plugin lookup tables keyed by manifest ids, channels, providers, and commands. */
import type { GatewayStartupPluginPlan } from "./gateway-startup-plugin-contracts.js";
import { loadGatewayStartupPluginPlanWithMetadata } from "./gateway-startup-plugin-loader.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { normalizeWorkerProviderIds } from "./worker-provider-id.js";

type PluginLookUpTableMetrics = PluginMetadataSnapshot["metrics"] & {
  startupPlanMs: number;
  startupPluginCount: number;
};

export type PluginLookUpTable = PluginMetadataSnapshot & {
  startup: GatewayStartupPluginPlan;
  workerProviderIds: readonly string[];
  metrics: PluginLookUpTableMetrics;
};

type LoadPluginLookUpTableParams = Omit<
  Parameters<typeof loadGatewayStartupPluginPlanWithMetadata>[0],
  "platform"
>;

export function loadPluginLookUpTable(params: LoadPluginLookUpTableParams): PluginLookUpTable {
  const workerProviderIds = normalizeWorkerProviderIds(params.workerProviderIds ?? []);
  const {
    metadataSnapshot,
    plan: startup,
    startupPlanMs,
  } = loadGatewayStartupPluginPlanWithMetadata({ ...params, workerProviderIds });

  return {
    ...metadataSnapshot,
    startup,
    workerProviderIds,
    metrics: {
      ...metadataSnapshot.metrics,
      startupPlanMs,
      totalMs: metadataSnapshot.metrics.totalMs + startupPlanMs,
      startupPluginCount: startup.pluginIds.length,
    },
  };
}
