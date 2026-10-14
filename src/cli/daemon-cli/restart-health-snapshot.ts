import type { GatewayRestartSnapshot } from "./restart-health.types.js";

// Both callers pass a fresh snapshot that has not escaped inspection.
export function finalizeGatewayRestartSnapshot(
  snapshot: GatewayRestartSnapshot,
  expectedVersion: string | undefined,
  expectedBuildId: string | undefined,
  requirePluginHealth: boolean,
): GatewayRestartSnapshot {
  if (expectedVersion) {
    snapshot.expectedVersion = expectedVersion;
    if (snapshot.gatewayVersion !== expectedVersion) {
      snapshot.healthy = false;
      if (snapshot.gatewayVersion != null) {
        snapshot.versionMismatch = {
          expected: expectedVersion,
          actual: snapshot.gatewayVersion,
        };
      }
    }
  }
  // Runtime identity remains required even with a separately configured UI root.
  if (expectedBuildId) {
    snapshot.expectedBuildId = expectedBuildId;
    if (snapshot.gatewayBuildId !== expectedBuildId) {
      snapshot.healthy = false;
      if (snapshot.gatewayBuildId !== undefined) {
        snapshot.buildIdMismatch = {
          expected: expectedBuildId,
          actual: snapshot.gatewayBuildId ?? null,
        };
      }
    }
  }
  if (
    (requirePluginHealth && snapshot.activatedPluginErrors?.length) ||
    snapshot.channelProbeErrors?.length
  ) {
    snapshot.healthy = false;
  }
  return snapshot;
}
