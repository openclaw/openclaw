import type { GatewayHealthReadiness } from "../../gateway/health/types.js";
import type {
  GatewayRestartHealthPurpose,
  GatewayRestartSnapshot,
} from "./restart-health.types.js";

type ReadinessAcceptance = {
  purpose?: GatewayRestartHealthPurpose;
  env?: NodeJS.ProcessEnv;
  requirePluginHealth?: boolean;
};

/** The caller selects its contract; a shipped updater marker upgrades lifecycle proof. */
export function acceptsGatewayReadiness(
  readiness: GatewayHealthReadiness | undefined,
  params: ReadinessAcceptance,
): boolean {
  if (
    params.purpose === "diagnostic" ||
    (params.purpose === "lifecycle" &&
      (params.env ?? process.env).OPENCLAW_UPDATE_IN_PROGRESS !== "1")
  ) {
    return true;
  }
  // Older Gateways keep their separate transport, identity, plugin and channel checks.
  return (
    !readiness ||
    readiness.state === "ready" ||
    (params.requirePluginHealth === false &&
      readiness.state === "degraded" &&
      readiness.reasons.length > 0 &&
      readiness.reasons.every((reason) => reason.startsWith("plugin:")))
  );
}

// Both callers pass a fresh snapshot that has not escaped inspection.
export function finalizeGatewayRestartSnapshot(
  snapshot: GatewayRestartSnapshot,
  params: ReadinessAcceptance & {
    expectedVersion?: string;
    expectedBuildId?: string;
    requirePluginHealth: boolean;
  },
): GatewayRestartSnapshot {
  const { expectedVersion, expectedBuildId, requirePluginHealth } = params;
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
  if (!acceptsGatewayReadiness(snapshot.readiness, params)) {
    snapshot.healthy = false;
    if (snapshot.readiness?.state === "starting") {
      snapshot.startupPhase = snapshot.readiness.reasons.join(", ") || "Gateway startup";
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
