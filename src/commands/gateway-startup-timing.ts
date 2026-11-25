import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../infra/update-run-timeouts.js";

type GatewayStartupTiming = { deadlineMs: number; probeTimeoutMs: number };
type UpdateStartupTiming = {
  timeoutMs?: number;
  migrationLeaseMs: number;
};

// Service activation precedes cold-start loading and the authenticated handshake.
// Setup and update observers share the Windows cold-boot allowance.
export function resolveGatewayStartupTiming(platform?: NodeJS.Platform): GatewayStartupTiming;
export function resolveGatewayStartupTiming(
  platform: NodeJS.Platform,
  update: UpdateStartupTiming,
): GatewayStartupTiming & { derivation: string };
export function resolveGatewayStartupTiming(
  platform: NodeJS.Platform = process.platform,
  update?: UpdateStartupTiming,
) {
  const windows = platform === "win32";
  const timing = {
    // Windows cold boots with large agent databases can take tens of minutes.
    // Allow activation, cold loading, and readiness one normal update step each.
    deadlineMs: windows ? 3 * DEFAULT_UPDATE_STEP_TIMEOUT_MS : 45_000,
    probeTimeoutMs: windows ? 15_000 : 10_000,
  };
  if (!update) {
    return timing;
  }
  // Keep the state/SQLite lease owner out of setup's eager import graph.
  const floorMs = Math.max(update.migrationLeaseMs, windows ? timing.deadlineMs : 0);
  return {
    ...timing,
    deadlineMs: update.timeoutMs ?? floorMs,
    derivation:
      update.timeoutMs !== undefined ? "explicit --timeout" : `${floorMs}ms startup floor`,
  };
}
