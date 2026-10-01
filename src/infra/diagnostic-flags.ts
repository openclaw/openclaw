import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntriesLower } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseDiagnosticEnvFlags } from "./diagnostic-flags-env.js";

const DIAGNOSTICS_ENV = "OPENCLAW_DIAGNOSTICS";

/** Resolves enabled diagnostic flags from config plus `OPENCLAW_DIAGNOSTICS` overrides. */
function resolveDiagnosticFlags(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const configFlags = Array.isArray(cfg?.diagnostics?.flags) ? cfg?.diagnostics?.flags : [];
  const envFlags = parseDiagnosticEnvFlags(env[DIAGNOSTICS_ENV]);
  if (envFlags.disablesAll) {
    return [];
  }
  return normalizeUniqueStringEntriesLower([...configFlags, ...envFlags.flags]);
}

/** Matches one diagnostic flag against exact, wildcard, and namespace-enabled flags. */
function matchesDiagnosticFlag(flag: string, enabledFlags: string[]): boolean {
  const target = normalizeLowercaseStringOrEmpty(flag);
  if (!target) {
    return false;
  }
  for (const raw of enabledFlags) {
    const enabled = normalizeLowercaseStringOrEmpty(raw);
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

/** Returns whether a diagnostic flag is enabled after config/env resolution. */
export function isDiagnosticFlagEnabled(
  flag: string,
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return matchesDiagnosticFlag(flag, resolveDiagnosticFlags(cfg, env));
}
