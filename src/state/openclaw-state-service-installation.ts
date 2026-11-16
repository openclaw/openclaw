import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { getGatewayServiceInstallation } from "../infra/gateway-service-installation-context.js";
import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";

/** Keep filesystem and refusal dependencies out of the eager CLI/worker context graph. */
export function assertGatewayServiceSchemaMigrationAllowed(
  databasePath: string,
  foundVersion: number,
  supportedVersion: number,
): void {
  const service = getGatewayServiceInstallation();
  if (
    service &&
    foundVersion > 0 &&
    foundVersion < supportedVersion &&
    service.databasePath === resolveIdentityPathViaExistingAncestorSync(databasePath)
  ) {
    throw new StartupMaintenanceRequiredError(
      "state-migrations",
      `Refusing a forward database schema migration: this CLI is ${service.cliVersion} but the Gateway service runs ${service.version} from ${service.root}; run openclaw update (or the CLI from ${service.root}).`,
    );
  }
}
