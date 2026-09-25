import {
  findServiceOwnershipRefusal,
  sanitizeServiceInspectionError,
} from "../../daemon/service-inspection-error.js";
import { createServiceRuntimeInspectionFailure } from "../../daemon/service-runtime.js";
import type { GatewayServiceEnvArgs, GatewayServiceState } from "../../daemon/service-types.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";

type DaemonServiceState = Pick<
  GatewayServiceState,
  "command" | "env" | "loadState" | "runtime" | "inspectionReason" | "systemdInstallation"
> & { inspectionFailed?: true };

/** Status may report incomplete inspection, but it cannot override an observed owner. */
export async function readDaemonServiceStatus(
  args: GatewayServiceEnvArgs,
): Promise<{ service: GatewayService; state: DaemonServiceState }> {
  const service = resolveGatewayService();
  const state: DaemonServiceState = await readGatewayServiceState(service, args).catch(
    (error: unknown): DaemonServiceState => {
      const refusal = findServiceOwnershipRefusal(error);
      if (refusal) {
        throw refusal;
      }
      // Discovery can require service files that this diagnostic CLI cannot read.
      const runtime = createServiceRuntimeInspectionFailure(sanitizeServiceInspectionError(error));
      return {
        inspectionFailed: true,
        command: null,
        env: args.env ?? process.env,
        loadState: { status: "unknown", detail: "Service installation could not be inspected." },
        runtime,
        inspectionReason: runtime.inspectionReason,
      };
    },
  );
  return { service, state };
}
