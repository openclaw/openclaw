/** Resolves cheap, secret-free local credential evidence declared by provider manifests. */
import fs from "node:fs";
import os from "node:os";
import { normalizeOptionalString as normalizeOptionalPathInput } from "@openclaw/normalization-core/string-coerce";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import type { ProviderAuthEvidence } from "./provider-env-vars.js";

type ResolvedLocalProviderAuthEvidence = {
  credentialMarker: string;
  source: string;
};

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

function hasLocalFileAuthEvidence(evidence: ProviderAuthEvidence, env: NodeJS.ProcessEnv): boolean {
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
): ResolvedLocalProviderAuthEvidence | null {
  for (const evidence of evidenceEntries ?? []) {
    if (
      evidence.type !== "local-file-with-env" ||
      !hasRequiredAuthEvidenceEnv(evidence, env) ||
      !hasLocalFileAuthEvidence(evidence, env)
    ) {
      continue;
    }
    return {
      credentialMarker: evidence.credentialMarker,
      source: evidence.source ?? "local auth evidence",
    };
  }
  return null;
}
