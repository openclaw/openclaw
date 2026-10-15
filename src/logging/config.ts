import fs from "node:fs";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveConfigEnvVars } from "../config/env-substitution.js";
import { resolveConfigIncludes, resolveConfigIncludesForTopLevelKey } from "../config/includes.js";
import { resolveConfigPath, resolveIncludeRoots } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tryProcessCwd } from "../infra/safe-cwd.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { APPLIED_LOGGING_CONFIG_UNOWNED, loggingState } from "./state.js";

// Lightweight logging-config reader used before the full config runtime is safe to load.
type LoggingConfig = NonNullable<OpenClawConfig["logging"]>;

let cachedLoggingConfig:
  | {
      selector: string;
      logging: LoggingConfig | undefined;
    }
  | undefined;

export function invalidateLoggingConfigCache(): void {
  cachedLoggingConfig = undefined;
}

function resolveLoggingConfigSelector(): string {
  const env = process.env;
  return [
    env.OPENCLAW_CONFIG_PATH,
    env.OPENCLAW_STATE_DIR,
    env.OPENCLAW_HOME,
    env.OPENCLAW_PROFILE,
    env.HOME,
    env.USERPROFILE,
    env.HOMEDRIVE,
    env.HOMEPATH,
    env.PREFIX,
    env.ANDROID_DATA,
    env.OPENCLAW_TEST_FAST,
    tryProcessCwd() ?? "",
  ]
    .map((value) => value ?? "")
    .join("\0");
}

function isUsableRedactPatternSource(value: unknown): value is string {
  // A blank source compiles to nothing, so keeping it would replace the default policy with an
  // operator list that masks nothing but the mandatory AWS matcher.
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * The canonical read parses the file without schema validation, so a declared `string[]` can hold
 * any JSON. An entry the redaction matcher loop cannot execute makes every redacted write throw instead of
 * masking, so unusable entries are dropped here while usable ones keep their policy.
 */
function withValidatedRedactPatterns(logging: Record<string, unknown>): Record<string, unknown> {
  const patterns = logging.redactPatterns;
  if (
    patterns === undefined ||
    (Array.isArray(patterns) && patterns.every(isUsableRedactPatternSource))
  ) {
    return logging;
  }
  if (!Array.isArray(patterns)) {
    // A non-list value cannot express a pattern list at all, and the resolver would read a string's
    // own length and iterate its characters as patterns.
    const { redactPatterns: _notAList, ...rest } = logging;
    return rest;
  }
  // Drop only what the matcher loop cannot execute: the operator's valid rules must keep masking,
  // because discarding the whole list would expose exactly the values they configured. An empty
  // result falls back to the built-in patterns through usesBuiltInRedactPatterns.
  return { ...logging, redactPatterns: patterns.filter(isUsableRedactPatternSource) };
}

/**
 * Applied snapshots come from callers that may publish a config which failed validation, such as
 * read-only status scans, so the same normalization runs for that producer instead of on every read.
 */
export function sanitizeAppliedLoggingConfig(
  logging: LoggingConfig | undefined,
): LoggingConfig | undefined {
  if (!logging || !isObjectRecord(logging)) {
    return logging;
  }
  return withValidatedRedactPatterns(logging) as LoggingConfig;
}

function resolvePartialDiagnosticLoggingConfig(logging: unknown): LoggingConfig | undefined {
  if (!isObjectRecord(logging)) {
    return undefined;
  }
  const partial: Record<string, unknown> = {};
  if (typeof logging.consoleStyle === "string") {
    try {
      const resolved = resolveConfigEnvVars({ consoleStyle: logging.consoleStyle });
      if (
        isObjectRecord(resolved) &&
        (resolved.consoleStyle === "pretty" ||
          resolved.consoleStyle === "compact" ||
          resolved.consoleStyle === "json")
      ) {
        partial.consoleStyle = resolved.consoleStyle;
      }
    } catch {
      // Keep resolving independent diagnostic fields.
    }
  }
  if (Array.isArray(logging.redactPatterns)) {
    try {
      const resolved = resolveConfigEnvVars({ redactPatterns: logging.redactPatterns });
      if (
        isObjectRecord(resolved) &&
        Array.isArray(resolved.redactPatterns) &&
        resolved.redactPatterns.every((entry) => typeof entry === "string")
      ) {
        partial.redactPatterns = resolved.redactPatterns;
      }
    } catch {
      // A missing variable in one pattern must not hide a separately resolvable style.
    }
  }
  return Object.keys(partial).length > 0 ? (partial as LoggingConfig) : undefined;
}

/** Reads the logging block from config, caching by resolved config path. */
export function readLoggingConfig(): LoggingConfig | undefined {
  try {
    if (loggingState.appliedConfig !== APPLIED_LOGGING_CONFIG_UNOWNED) {
      return loggingState.appliedConfig;
    }
    const selector = resolveLoggingConfigSelector();
    if (cachedLoggingConfig?.selector === selector) {
      return cachedLoggingConfig.logging;
    }
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      cachedLoggingConfig = { selector, logging: undefined };
      return undefined;
    }
    const parsed = parseJsonWithJson5Fallback(fs.readFileSync(configPath, "utf8"));
    const allowedRoots = resolveIncludeRoots();
    let includedConfig: unknown;
    try {
      includedConfig = resolveConfigIncludesForTopLevelKey(
        parsed,
        configPath,
        "logging",
        undefined,
        { allowedRoots },
      );
    } catch {
      // Validation commands still need a directly-authored logging style when an unrelated
      // root include is malformed. Resolve only that subtree through the same canonical rules.
      const directLogging = isObjectRecord(parsed) ? parsed.logging : undefined;
      if (directLogging === undefined) {
        return undefined;
      }
      try {
        includedConfig = resolveConfigIncludes({ logging: directLogging }, configPath, undefined, {
          allowedRoots,
        });
      } catch {
        return resolvePartialDiagnosticLoggingConfig(directLogging);
      }
    }
    let resolvedConfig: unknown;
    try {
      resolvedConfig = resolveConfigEnvVars(includedConfig);
    } catch {
      const includedLogging = isObjectRecord(includedConfig) ? includedConfig.logging : undefined;
      return resolvePartialDiagnosticLoggingConfig(includedLogging);
    }
    const logging = isObjectRecord(resolvedConfig) ? resolvedConfig.logging : undefined;
    const resolvedLogging = isObjectRecord(logging)
      ? (withValidatedRedactPatterns(logging) as LoggingConfig)
      : undefined;
    cachedLoggingConfig = {
      selector,
      logging: resolvedLogging,
    };
    return resolvedLogging;
  } catch {
    return undefined;
  }
}
