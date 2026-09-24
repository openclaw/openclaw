import { isRecord } from "../utils.js";
import type { ConfigHealthEntry, ConfigHealthFingerprint } from "./io.health-state.types.js";

type ConfigObserveSuspiciousBaseline = {
  bytes: number;
  hasMeta: boolean;
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

export function resolveConfigObserveSuspiciousReasons(params: {
  bytes: number;
  hasMeta: boolean;
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
  if (baseline.hasMeta && !params.hasMeta) {
    reasons.push("missing-meta-vs-last-good");
  }
  if (baseline.gatewayMode && !params.gatewayMode) {
    reasons.push("gateway-mode-missing-vs-last-good");
  }
  if (baseline.gatewayMode && isUpdateChannelOnlyRoot(params.parsed)) {
    reasons.push("update-channel-only-root");
  }
  return reasons;
}

function isRecoverableConfigReadSuspiciousReason(reason: string): boolean {
  return (
    reason === "missing-meta-vs-last-good" ||
    reason === "gateway-mode-missing-vs-last-good" ||
    reason === "update-channel-only-root" ||
    reason.startsWith("size-drop-vs-last-good:")
  );
}

export function resolveConfigReadRecoveryContext(params: {
  current: ConfigHealthFingerprint;
  parsed: unknown;
  entry: ConfigHealthEntry;
  backupBaseline?: ConfigHealthFingerprint;
}): { suspicious: string[]; suspiciousSignature: string } | null {
  const suspicious = resolveConfigObserveSuspiciousReasons({
    bytes: params.current.bytes,
    hasMeta: params.current.hasMeta,
    gatewayMode: params.current.gatewayMode,
    parsed: params.parsed,
    lastKnownGood: params.backupBaseline,
  });
  if (!suspicious.some(isRecoverableConfigReadSuspiciousReason)) {
    return null;
  }
  const suspiciousSignature = `${params.current.hash}:${suspicious.join(",")}`;
  if (params.entry.lastObservedSuspiciousSignature === suspiciousSignature) {
    return null;
  }
  return { suspicious, suspiciousSignature };
}
