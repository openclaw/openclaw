import { stableStringify } from "@openclaw/normalization-core";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";

let configFingerprints = new WeakMap<OpenClawConfig, string>();

export function fingerprintSkillSnapshotConfig(config: OpenClawConfig): string {
  const cached = configFingerprints.get(config);
  if (cached) {
    return cached;
  }
  const fingerprint = sha256Hex(stableStringify(redactConfigObject(config)));
  configFingerprints.set(config, fingerprint);
  return fingerprint;
}

export function resetSkillSnapshotConfigFingerprintCache(): void {
  configFingerprints = new WeakMap();
}
