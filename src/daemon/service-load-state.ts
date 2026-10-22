import {
  assertServiceInspectionFallbackAllowed,
  ServiceInspectionError,
} from "./service-inspection-error.js";
import type {
  GatewayService,
  GatewayServiceEnvArgs,
  GatewayServiceLoadState,
  GatewayServiceLoadStateReader,
} from "./service-types.js";

export async function readGatewayServiceLoadState(
  service: GatewayServiceLoadStateReader,
  args: GatewayServiceEnvArgs = {},
): Promise<GatewayServiceLoadState> {
  try {
    return { status: (await service.isLoaded(args)) ? "loaded" : "not-loaded" };
  } catch (error) {
    assertServiceInspectionFallbackAllowed(error);
    return {
      status: "unknown",
      detail: String(error),
      ...(error instanceof ServiceInspectionError ? { inspectionReason: error.reason } : {}),
    };
  }
}

/** systemd reports enablement as loaded; a stopped, disabled unit still has an installed definition. */
export async function isGatewayServiceInstalled(
  service: Pick<GatewayService, "isLoaded" | "hasInstalledDefinition">,
  args: GatewayServiceEnvArgs,
): Promise<boolean> {
  return (await service.isLoaded(args)) || (await service.hasInstalledDefinition?.(args)) === true;
}
