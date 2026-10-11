import type { startGatewayMaintenanceTimers } from "./server-maintenance.js";

export type GatewayMaintenanceHandles = ReturnType<typeof startGatewayMaintenanceTimers>;

export async function clearGatewayMaintenanceHandles(
  maintenance: GatewayMaintenanceHandles | null,
): Promise<void> {
  if (!maintenance) {
    return;
  }
  // Maintenance startup can race shutdown. Join every owner before discarding
  // its state directory and SQLite handles, including when another stop fails.
  const results = await Promise.allSettled(
    [maintenance.stopPeriodicTasks, maintenance.skillUsageCleanup].map(
      async (stop) => await stop(),
    ),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Gateway maintenance cleanup failed");
  }
}
