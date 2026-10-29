import {
  inspectGatewayServiceInstallationDrift,
  summarizeGatewayServiceLayout,
} from "../daemon/service-layout.js";
import { resolveGatewayService } from "../daemon/service.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import type { GatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { compareOpenClawReleaseVersions } from "../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";

/** Unknown service installations retain normal CLI behavior; only proven older installs restrict migration. */
export async function inspectCliGatewayServiceInstallation(
  env: NodeJS.ProcessEnv,
): Promise<GatewayServiceInstallation | undefined> {
  try {
    const command = await resolveGatewayService().readCommand(env);
    const root = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
    const layout = await summarizeGatewayServiceLayout(command);
    const drift = root ? await inspectGatewayServiceInstallationDrift(layout, root) : undefined;
    if (
      !drift?.serviceVersion ||
      (compareOpenClawReleaseVersions(VERSION, drift.serviceVersion) ?? 0) <= 0
    ) {
      return undefined;
    }
    return {
      root: drift.serviceRoot,
      version: drift.serviceVersion,
      cliVersion: VERSION,
      databasePath: resolveIdentityPathViaExistingAncestorSync(
        resolveOpenClawStateSqlitePath({ ...env, ...command?.environment }),
      ),
    };
  } catch {
    // Service inspection is best effort and must not make an uninspectable host unusable.
    return undefined;
  }
}
