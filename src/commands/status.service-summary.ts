import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import { readGatewayServiceState, type GatewayService } from "../daemon/service.js";

export type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByMullusi: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
};

export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    const state = await readGatewayServiceState(service, { env: process.env });
    const managedByMullusi = state.installed;
    const externallyManaged = !managedByMullusi && state.running;
    const installed = managedByMullusi || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : state.loaded
        ? service.loadedText
        : service.notLoadedText;
    return {
      label: service.label,
      installed,
      loaded: state.loaded,
      managedByMullusi,
      externallyManaged,
      loadedText,
      runtime: state.runtime,
    };
  } catch {
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByMullusi: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}
