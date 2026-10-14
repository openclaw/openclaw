/** Builds plugin lookup tables keyed by manifest ids, channels, providers, and commands. */
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GatewayStartupPluginPlan } from "./gateway-startup-plugin-contracts.js";
import { loadGatewayStartupPluginPlanWithMetadata } from "./gateway-startup-plugin-loader.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import type { PluginRegistrySnapshot } from "./plugin-registry-snapshot.js";
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

type LoadPluginLookUpTableParams = {
  config: OpenClawConfig;
  activationSourceConfig?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  index?: PluginRegistrySnapshot;
  metadataSnapshot?: PluginMetadataSnapshot;
  workerProviderIds?: readonly string[];
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
};

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
