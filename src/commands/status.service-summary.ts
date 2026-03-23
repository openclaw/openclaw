import type { GatewayServiceRuntime } from "../daemon/service-runtime.js";
import type { GatewayService } from "../daemon/service.js";

export type ServiceStatusSummary = {
  label: string;
  installed: boolean | null;
  loaded: boolean;
  managedByOpenClaw: boolean;
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
    const label = command?.label ?? service.label;
    const loadedLabel = command?.loadedText ?? service.loadedText;
    const notLoadedLabel = command?.notLoadedText ?? service.notLoadedText;
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
    const managedByOpenClaw = command != null;
    const externallyManaged = !managedByOpenClaw && runtime?.status === "running";
    const installed = managedByOpenClaw || externallyManaged;
    const loadedText = externallyManaged
      ? "running (externally managed)"
      : loaded
        ? loadedLabel
        : notLoadedLabel;
    return {
      label,
      installed,
      loaded,
      managedByOpenClaw,
      externallyManaged,
      loadedText,
      runtime,
    };
  } catch {
    return {
      label: fallbackLabel,
      installed: null,
      loaded: false,
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "unknown",
      runtime: undefined,
    };
  }
}
