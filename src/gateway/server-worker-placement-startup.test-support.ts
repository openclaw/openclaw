import { prepareSessionMaintenancePreservation } from "../config/sessions/store-maintenance-preserve.js";
import type { GatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";
import { startRuntime } from "./server-worker-placement.test-support.js";

export async function startPlacementRuntime(
  runtime: GatewayWorkerPlacementRuntime,
  overrides: Partial<Parameters<typeof runtime.startRuntime>[0]> = {},
) {
  const sidecar = await startRuntime(runtime, overrides);
  if (!sidecar) {
    throw new Error("worker placement runtime did not start");
  }
  return sidecar;
}

export async function preservedSessionKeys() {
  const prepared = await prepareSessionMaintenancePreservation("unused-store");
  try {
    return new Set(prepared.capture().providerKeys);
  } finally {
    prepared.dispose();
  }
}
