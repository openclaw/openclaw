import { DEFAULT_UPDATE_STEP_TIMEOUT_MS } from "../infra/update-run-timeouts.js";

// Service activation precedes cold-start loading and the authenticated handshake.
// All managed setup observers share this platform-specific startup allowance.
export function resolveGatewayStartupTiming(platform: NodeJS.Platform = process.platform) {
  const windows = platform === "win32";
  return {
    // Windows cold boots with large agent databases can take tens of minutes.
    // Allow activation, cold loading, and readiness one normal update step each.
    deadlineMs: windows ? 3 * DEFAULT_UPDATE_STEP_TIMEOUT_MS : 45_000,
    probeTimeoutMs: windows ? 15_000 : 10_000,
  };
}
