/**
 * Build a ConfigFileSnapshot from a raw config string (e.g. from Nacos).
 * Uses the same parse/validate/defaults pipeline as file-based config; $include
 * resolution is skipped (Nacos mode does not support includes).
 */

import crypto from "node:crypto";
import JSON5 from "json5";
import {
  applyAgentDefaults,
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applyModelDefaults,
  applySessionDefaults,
  applyTalkApiKey,
  applyTalkConfigNormalization,
} from "../defaults.js";
import type { EnvSubstitutionWarning } from "../env-substitution.js";
import { resolveConfigEnvVars } from "../env-substitution.js";
import { applyConfigEnvVars } from "../env-vars.js";
import { parseConfigJson5 } from "../io.js";
import { findLegacyConfigIssues } from "../legacy.js";
import { normalizeExecSafeBinProfilesInConfig } from "../normalize-exec-safe-bin.js";
import { normalizeConfigPaths } from "../normalize-paths.js";
import type { ConfigFileSnapshot, LegacyConfigIssue, OpenClawConfig } from "../types.js";
import { validateConfigObjectWithPlugins } from "../validation.js";

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

function coerceConfig(value: unknown): OpenClawConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as OpenClawConfig;
}

export type BuildSnapshotFromRawOptions = {
  env: NodeJS.ProcessEnv;
};

/**
 * Build a ConfigFileSnapshot from a raw JSON5 string and virtual path.
 * Same parsing/validation/defaults chain as file-based config; $include is not resolved.
 */
export async function buildSnapshotFromRaw(
  raw: string,
  path: string,
  opts: BuildSnapshotFromRawOptions,
): Promise<ConfigFileSnapshot> {
  const hash = hashConfigRaw(raw);
  const parsedRes = parseConfigJson5(raw, JSON5);
  if (!parsedRes.ok) {
    return {
      path,
      exists: true,
      raw,
      parsed: {},
      resolved: {},
      valid: false,
      config: {},
      hash,
      issues: [{ path: "", message: `JSON5 parse failed: ${parsedRes.error}` }],
      warnings: [],
      legacyIssues: [],
    };
  }

  // Nacos: no $include resolution; use parsed as resolved input for env substitution.
  const envWarnings: EnvSubstitutionWarning[] = [];
  const envCopy = { ...opts.env };
  if (
    parsedRes.parsed &&
    typeof parsedRes.parsed === "object" &&
    "env" in (parsedRes.parsed as object)
  ) {
    applyConfigEnvVars(parsedRes.parsed as OpenClawConfig, envCopy);
  }
  const resolvedConfigRaw = resolveConfigEnvVars(parsedRes.parsed, envCopy, {
    onMissing: (w) => envWarnings.push(w),
  });

  const envVarWarnings = envWarnings.map((w) => ({
    path: w.configPath,
    message: `Missing env var "${w.varName}" — feature using this value will be unavailable`,
  }));

  const legacyIssues: LegacyConfigIssue[] = findLegacyConfigIssues(
    resolvedConfigRaw,
    parsedRes.parsed,
  );

  const validated = validateConfigObjectWithPlugins(resolvedConfigRaw);
  if (!validated.ok) {
    return {
      path,
      exists: true,
      raw,
      parsed: parsedRes.parsed,
      resolved: coerceConfig(resolvedConfigRaw),
      valid: false,
      config: coerceConfig(resolvedConfigRaw),
      hash,
      issues: validated.issues,
      warnings: [...validated.warnings, ...envVarWarnings],
      legacyIssues,
    };
  }

  const snapshotConfig = normalizeConfigPaths(
    applyTalkApiKey(
      applyTalkConfigNormalization(
        applyModelDefaults(
          applyCompactionDefaults(
            applyContextPruningDefaults(
              applyAgentDefaults(
                applySessionDefaults(applyLoggingDefaults(applyMessageDefaults(validated.config))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  normalizeExecSafeBinProfilesInConfig(snapshotConfig);

  return {
    path,
    exists: true,
    raw,
    parsed: parsedRes.parsed,
    resolved: coerceConfig(resolvedConfigRaw),
    valid: true,
    config: snapshotConfig,
    hash,
    issues: [],
    warnings: [...validated.warnings, ...envVarWarnings],
    legacyIssues,
  };
}
