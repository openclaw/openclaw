import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

export function isValidProfileName(value: string): boolean {
  return PROFILE_NAME_RE.test(value);
}

export function normalizeProfileName(raw?: string | null): string | null {
  const profile = raw?.trim();
  if (!profile) {
    return null;
  }
  if (normalizeLowercaseStringOrEmpty(profile) === "default") {
    return null;
  }
  if (!isValidProfileName(profile)) {
    return null;
  }
  return profile;
}

export function resolveProfileGatewayPort(profile: string): number {
  if (profile === "dev") {
    return 19001;
  }
  // Keep byte-for-byte aligned with AppProfile.defaultGatewayPort in
  // apps/macos/Sources/OpenClaw/AppProfile.swift so both surfaces connect to the same Gateway.
  let hash = 2_166_136_261;
  for (const byte of Buffer.from(profile, "utf8")) {
    hash = Math.imul(hash ^ byte, 16_777_619) >>> 0;
  }
  return 20_000 + (hash % 40_000);
}

/** Resolve the canonical home-scoped state root for a validated CLI profile. */
export function resolveProfileStateDir(
  profile: string,
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  const trimmed = profile.trim();
  if (!isValidProfileName(trimmed)) {
    throw new Error(`Invalid profile name: ${JSON.stringify(profile)}`);
  }
  const suffix = normalizeLowercaseStringOrEmpty(trimmed) === "default" ? "" : `-${trimmed}`;
  return path.join(resolveRequiredHomeDir(env, homedir), `.openclaw${suffix}`);
}
