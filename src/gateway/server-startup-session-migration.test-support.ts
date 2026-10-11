import {
  prepareGatewayStartupSessions,
  runGatewaySessionStartupMaintenance,
} from "./server-startup-session-migration.js";

/** Exercise admission and its repair handoff together for existing store fixtures. */
export async function runStartupSessionMaintenanceForTest(
  params: Parameters<typeof prepareGatewayStartupSessions>[0],
): Promise<void> {
  const databases = await prepareGatewayStartupSessions(params);
  await runGatewaySessionStartupMaintenance({ ...params, databases });
}
