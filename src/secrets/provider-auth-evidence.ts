/** Resolves cheap, secret-free local credential evidence declared by provider manifests. */
import fs from "node:fs";
import os from "node:os";
import { normalizeOptionalString as normalizeOptionalPathInput } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { ProviderAuthEvidence } from "./provider-env-vars.js";

function expandAuthEvidencePath(
  rawPath: string,
  env: NodeJS.ProcessEnv,
): { path: string; explicitOverride: boolean } | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }
  let unresolvedPlaceholder = false;
  let explicitOverride = false;
  const placeholderPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;
  const invalidPlaceholder = trimmed.replace(placeholderPattern, "").includes("${");
  const expanded = trimmed.replace(placeholderPattern, (_match, name: string) => {
    const value =
      name === "HOME"
        ? (normalizeOptionalPathInput(env.HOME) ?? os.homedir())
        : normalizeOptionalPathInput(env[name]);
    if (!value) {
      unresolvedPlaceholder = true;
      return "";
    }
    if (name !== "HOME" && name !== "APPDATA") {
      explicitOverride = true;
    }
    return value;
  });
  return unresolvedPlaceholder || invalidPlaceholder
    ? undefined
    : { path: expanded, explicitOverride };
}

function hasRequiredAuthEvidenceEnv(
  evidence: ProviderAuthEvidence,
  env: NodeJS.ProcessEnv,
): boolean {
  const hasEnv = (key: string) => Boolean(normalizeOptionalSecretInput(env[key]));
  if (evidence.requiresAnyEnv?.length && !evidence.requiresAnyEnv.some(hasEnv)) {
    return false;
  }
  if (evidence.requiresAllEnv?.length && !evidence.requiresAllEnv.every(hasEnv)) {
    return false;
  }
  return true;
}

function hasBlockedAuthEvidenceEnv(
  evidence: Extract<ProviderAuthEvidence, { type: "gce-metadata-with-env" }>,
  env: NodeJS.ProcessEnv,
): boolean {
  return Boolean(
    evidence.blockedByEnv?.some((key) => Boolean(normalizeOptionalSecretInput(env[key]))),
  );
}

function isGceMetadataEnvironment(env: NodeJS.ProcessEnv): boolean {
  if (
    normalizeOptionalPathInput(env.GCE_METADATA_HOST) ||
    normalizeOptionalPathInput(env.GCE_METADATA_IP)
  ) {
    return true;
  }
  try {
    if (fs.readFileSync("/sys/class/dmi/id/product_name", "utf8").trim() === "Google Compute Engine") {
      return true;
    }
  } catch {
    // Non-Linux or restricted sysfs.
  }
  try {
    if (fs.readFileSync("/sys/class/dmi/id/sys_vendor", "utf8").trim() === "Google") {
      return true;
    }
  } catch {
    // Non-Linux or restricted sysfs.
  }
  return false;
}

function hasLocalFileAuthEvidence(
  evidence: Extract<ProviderAuthEvidence, { type: "local-file-with-env" }>,
  env: NodeJS.ProcessEnv,
): boolean {
  if (evidence.fileEnvVar) {
    const explicitPath = normalizeOptionalPathInput(env[evidence.fileEnvVar]);
    if (explicitPath) {
      return fs.existsSync(explicitPath);
    }
  }
  for (const rawPath of evidence.fallbackPaths ?? []) {
    const expandedPath = expandAuthEvidencePath(rawPath, env);
    if (!expandedPath) {
      continue;
    }
    if (fs.existsSync(expandedPath.path)) {
      return true;
    }
    // An explicit provider directory owns identity; never select stale platform credentials.
    if (expandedPath.explicitOverride) {
      return false;
    }
  }
  return false;
}

export function resolveLocalProviderAuthEvidence(
  evidenceEntries: readonly ProviderAuthEvidence[] | undefined,
  env: NodeJS.ProcessEnv,
) {
  for (const evidence of evidenceEntries ?? []) {
    if (!hasRequiredAuthEvidenceEnv(evidence, env)) {
      continue;
    }
    if (evidence.type === "local-file-with-env") {
      if (!hasLocalFileAuthEvidence(evidence, env)) {
        continue;
      }
    } else if (evidence.type === "gce-metadata-with-env") {
      if (hasBlockedAuthEvidenceEnv(evidence, env) || !isGceMetadataEnvironment(env)) {
        continue;
      }
    } else {
      continue;
    }
    return {
      credentialMarker: evidence.credentialMarker,
      source: evidence.source ?? "local auth evidence",
    };
  }
  return null;
}
