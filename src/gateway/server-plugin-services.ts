import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { observeGatewayProviderUsageMetrics } from "./provider-usage-metrics-observer.js";

export type { PluginServicesHandle };

/** Starts Gateway-owned plugin services with their restricted host capabilities. */
export function startGatewayPluginServices(
  params: Parameters<typeof startPluginServices>[0],
): Promise<PluginServicesHandle> {
  return startPluginServices({
    ...params,
    observeProviderUsage: observeGatewayProviderUsageMetrics,
  });
}
