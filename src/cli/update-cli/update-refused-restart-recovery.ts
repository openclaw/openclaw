import {
  inspectGatewayServiceInstallationDrift,
  summarizeGatewayServiceLayout,
} from "../../daemon/service-layout.js";
import type { GatewayServiceCommandConfig } from "../../daemon/service-types.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";

// Verified in this state: `gateway restart` alone fails while the unit names the old package.
export const REFUSED_RESTART_RECOVERY =
  "Run `openclaw gateway install --force`, then `openclaw gateway restart`.";

/**
 * Shipped updaters can refuse the Gateway restart after a package switch (2026.11.5 and earlier
 * on pnpm). When the run ended `service-revalidation-failed` and the installed service still
 * runs a different package root than this installation, the recovery is to reinstall the
 * service definition from this package and restart it. The live service read decides; the
 * stored run alone cannot tell this from a genuinely foreign service.
 */
export async function resolveRefusedRestartRecovery(params: {
  run: Pick<UpdateRunRecord, "status" | "reason">;
  command: GatewayServiceCommandConfig | null | undefined;
  activeRoot: string | null | undefined;
}): Promise<string | undefined> {
  const { run, command, activeRoot } = params;
  if (
    run.status !== "failed" ||
    run.reason !== "service-revalidation-failed" ||
    !command ||
    !activeRoot
  ) {
    return undefined;
  }
  const drift = await inspectGatewayServiceInstallationDrift(
    await summarizeGatewayServiceLayout(command),
    activeRoot,
  );
  return drift ? REFUSED_RESTART_RECOVERY : undefined;
}
