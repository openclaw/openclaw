import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayService } from "../daemon/service.js";

export type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByEvox: boolean;
  externallyManaged: boolean;
  loadedText: string;
  runtime: GatewayServiceRuntime | undefined;
};

export async function readServiceStatusSummary(
  service: GatewayService,
  fallbackLabel: string,
): Promise<ServiceStatusSummary> {
  try {
    const command = await service.readCommand(process.env).catch(() => null);
    const serviceEnv = command?.environment
      ? ({
          ...process.env,
          ...command.environment,
        } satisfies NodeJS.ProcessEnv)
      : process.env;
    const [loaded, runtime] = await Promise.all([
      service.isLoaded({ env: serviceEnv }).catch(() => false),
      service.readRuntime(serviceEnv).catch(() => undefined),
    ]);
    const managedByEvox = command != null;
    const externallyManaged = !managedByEvox && runtime?.status === "running";
    const installed = managedByEvox || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : loaded
        ? service.loadedText
        : service.notLoadedText;
    return {
      label: service.label,
      installed,
      loaded,
      managedByEvox,
      externallyManaged,
      loadedText,
      runtime,
    };
  } catch {
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByEvox: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}
