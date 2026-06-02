import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DIAGNOSTICS_ENV = "OPENCLAW_DIAGNOSTICS";

type ParsedEnvFlags = {
  flags: string[];
  disablesAll: boolean;
};

function parseEnvFlags(raw?: string): ParsedEnvFlags {
  if (!raw) {
    return { flags: [], disablesAll: false };
  }
  const trimmed = raw.trim();
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (!lowered) {
    return { flags: [], disablesAll: false };
  }
  if (["0", "false", "off", "none"].includes(lowered)) {
    return { flags: [], disablesAll: true };
  }
  if (["1", "true", "all", "*"].includes(lowered)) {
    return { flags: ["*"], disablesAll: false };
  }
  return {
    flags: trimmed
      .split(/[,\s]+/)
      .map((value) => normalizeLowercaseStringOrEmpty(value))
      .filter(Boolean),
    disablesAll: false,
  };
}

function uniqueFlags(flags: string[]): string[] {
  return normalizeUniqueStringEntriesLower(flags);
}

/** Resolves configured diagnostic flags plus OPENCLAW_DIAGNOSTICS overrides. */
export function resolveDiagnosticFlags(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
  const envFlags = parseEnvFlags(env[DIAGNOSTICS_ENV]);
  // False-like env values are an operator override that disables config flags too.
  if (envFlags.disablesAll) {
    return [];
  }
  return uniqueFlags([...configFlags, ...envFlags.flags]);
}

/** Matches exact flags, "*" aliases, namespace wildcards, and raw prefix wildcards. */
export function matchesDiagnosticFlag(flag: string, enabledFlags: string[]): boolean {
  const target = normalizeLowercaseStringOrEmpty(flag);
  if (!target) {
    return false;
  }
  for (const raw of enabledFlags) {
    const enabled = normalizeLowercaseStringOrEmpty(raw);
    if (!enabled) {
      continue;
    }
    if (enabled === "*" || enabled === "all") {
      return true;
    }
    if (enabled.endsWith(".*")) {
      const prefix = enabled.slice(0, -2);
      if (target === prefix || target.startsWith(`${prefix}.`)) {
        return true;
      }
    }
    if (enabled.endsWith("*")) {
      const prefix = enabled.slice(0, -1);
      if (target.startsWith(prefix)) {
        return true;
      }
    }
    if (enabled === target) {
      return true;
    }
  }
  return false;
}

/** Resolves diagnostics for the current environment and checks a single flag. */
export function isDiagnosticFlagEnabled(
  flag: string,
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const flags = resolveDiagnosticFlags(cfg, env);
  return matchesDiagnosticFlag(flag, flags);
}
