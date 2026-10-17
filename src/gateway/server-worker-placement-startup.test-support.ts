import { vi } from "vitest";
import { prepareSessionMaintenancePreservation } from "../config/sessions/store-maintenance-preserve.js";
import type { GatewayWorkerPlacementRuntime } from "./server-worker-placement-startup.js";

export function createPlacementDiskSpaceFixture() {
  return {
    read: vi.fn(),
    version: vi.fn(() => 0),
    invalidate: vi.fn(),
    nextSweepAtMs: () => Infinity,
    sweep: vi.fn().mockResolvedValue(undefined),
  };
}

export async function startPlacementRuntime(
  runtime: GatewayWorkerPlacementRuntime,
  overrides: Partial<Parameters<typeof runtime.startRuntime>[0]> = {},
) {
  const sidecar = await runtime.startRuntime({
    isClosePreludeStarted: () => false,
    registerSidecar: vi.fn(),
    unregisterSidecar: vi.fn(),
    ...overrides,
  });
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
