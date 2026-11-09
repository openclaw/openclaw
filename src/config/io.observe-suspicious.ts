import { isRecord } from "../utils.js";
import type { ConfigHealthEntry, ConfigHealthFingerprint } from "./io.health-state.types.js";

type ConfigObserveSuspiciousBaseline = {
  bytes: number;
  gatewayMode: string | null;
};

function isUpdateChannelOnlyRoot(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "update") {
    return false;
  }
  const update = value.update;
  if (!isRecord(update)) {
    return false;
  }
  const updateKeys = Object.keys(update);
  return updateKeys.length === 1 && typeof update.channel === "string";
}

const inheritedAnomalyReason = "inherited-config-anomaly";

export function createInheritedConfigAnomalySignature(hash: string): string {
  return `${hash}:${inheritedAnomalyReason}`;
}

export function resolveConfigObserveSuspiciousReasons(params: {
  hash?: string;
  lastObservedSuspiciousSignature?: string | null;
  bytes: number;
  gatewayMode: string | null;
  parsed: unknown;
  lastKnownGood?: ConfigObserveSuspiciousBaseline;
}): string[] {
  const reasons: string[] = [];
  const baseline = params.lastKnownGood;
  if (!baseline) {
    return reasons;
  }
  if (baseline.bytes >= 512 && params.bytes < Math.floor(baseline.bytes * 0.5)) {
    reasons.push(`size-drop-vs-last-good:${baseline.bytes}->${params.bytes}`);
  }
  // ConfigMap seeds and operator-authored configs need not contain writer metadata.
  if (baseline.gatewayMode && !params.gatewayMode) {
    reasons.push("gateway-mode-missing-vs-last-good");
  }
  if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
    reasons.push("update-channel-only-root");
  }
  if (
    reasons.length === 0 &&
    params.hash &&
    params.lastObservedSuspiciousSignature === createInheritedConfigAnomalySignature(params.hash)
  ) {
    reasons.push(inheritedAnomalyReason);
  }
  return reasons;
}

export function resolveConfigReadRecoveryContext(params: {
  current: ConfigHealthFingerprint;
  parsed: unknown;
  entry: ConfigHealthEntry;
  backupBaseline?: ConfigHealthFingerprint;
}): { suspicious: string[]; suspiciousSignature: string } | null {
  const suspicious = resolveConfigObserveSuspiciousReasons({
    hash: params.current.hash,
    lastObservedSuspiciousSignature: params.entry.lastObservedSuspiciousSignature,
    bytes: params.current.bytes,
    gatewayMode: params.current.gatewayMode,
    parsed: params.parsed,
    lastKnownGood: params.backupBaseline,
  });
  if (suspicious.length === 0) {
    return null;
  }
  const suspiciousSignature = `${params.current.hash}:${suspicious.join(",")}`;
  if (params.entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return null;
  }
  return { suspicious, suspiciousSignature };
}
