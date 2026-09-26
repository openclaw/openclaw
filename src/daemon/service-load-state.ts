import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { findServiceOwnershipRefusal, ServiceInspectionError } from "./service-inspection-error.js";
import type {
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
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const refusal = findServiceOwnershipRefusal(error);
    if (refusal) {
      throw refusal;
    }
    return {
      status: "unknown",
      detail: String(error),
      ...(error instanceof ServiceInspectionError ? { inspectionReason: error.reason } : {}),
    };
  }
}
