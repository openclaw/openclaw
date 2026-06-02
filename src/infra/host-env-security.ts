import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { HOST_ENV_SECURITY_POLICY } from "./host-env-security-policy.js";
import { markOpenClawExecEnv } from "./openclaw-exec-env.js";

const PORTABLE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_COMPAT_OVERRIDE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_()]*$/;

const HOST_DANGEROUS_ENV_KEY_VALUES: readonly string[] = Object.freeze([
  ...HOST_ENV_SECURITY_POLICY.blockedKeys,
]);
const HOST_DANGEROUS_ENV_PREFIXES: readonly string[] = Object.freeze([
  ...HOST_ENV_SECURITY_POLICY.blockedPrefixes,
]);
const HOST_DANGEROUS_INHERITED_ENV_KEY_VALUES: readonly string[] = Object.freeze([
  ...HOST_ENV_SECURITY_POLICY.blockedInheritedKeys,
]);
const HOST_DANGEROUS_INHERITED_ENV_PREFIXES: readonly string[] = Object.freeze([
  ...HOST_ENV_SECURITY_POLICY.blockedInheritedPrefixes,
]);
const HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES: readonly string[] = Object.freeze([
  ...HOST_ENV_SECURITY_POLICY.blockedOverrideKeys,
]);
const HOST_DANGEROUS_OVERRIDE_ENV_PREFIXES: readonly string[] = Object.freeze([
  ...HOST_ENV_SECURITY_POLICY.blockedOverridePrefixes,
]);
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES: readonly string[] = Object.freeze([
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
]);
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_PREFIX_VALUES: readonly string[] = Object.freeze([
  "LC_",
]);
const HOST_DANGEROUS_ENV_KEYS = new Set<string>(HOST_DANGEROUS_ENV_KEY_VALUES);
const HOST_DANGEROUS_INHERITED_ENV_KEYS = new Set<string>(HOST_DANGEROUS_INHERITED_ENV_KEY_VALUES);
const HOST_DANGEROUS_OVERRIDE_ENV_KEYS = new Set<string>(HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES);
const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS = new Set<string>(
  HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES,
);

function isShellWrapperAllowedOverrideEnvVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey, { portable: true });
  if (!key) {
    return false;
  }
  const upper = key.toUpperCase();
  if (HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS.has(upper)) {
    return true;
  }
  return HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_PREFIX_VALUES.some((prefix) =>
    upper.startsWith(prefix),
  );
}

/** Sanitized child-process environment plus diagnostics for rejected request overrides. */
type HostExecEnvSanitizationResult = {
  env: Record<string, string>;
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
};

/** Rejection details for callers that need validation without building a child env. */
type HostExecEnvOverrideDiagnostics = {
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
};

/**
 * Normalize an environment variable key before policy checks. `portable` mode is
 * intentionally stricter for shell-wrapper forwarding and daemon config files.
 */
export function normalizeEnvVarKey(
  rawKey: string,
  options?: { portable?: boolean },
): string | null {
  const key = rawKey.trim();
  if (!key) {
    return null;
  }
  if (options?.portable && !PORTABLE_ENV_VAR_KEY.test(key)) {
    return null;
  }
  return key;
}

/**
 * Normalize a request-supplied override key. Windows compatibility allows
 * function-style keys that can appear in inherited environments but rejects
 * other shell syntax before it reaches command execution.
 */
export function normalizeHostOverrideEnvVarKey(rawKey: string): string | null {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return null;
  }
  if (PORTABLE_ENV_VAR_KEY.test(key) || WINDOWS_COMPAT_OVERRIDE_ENV_VAR_KEY.test(key)) {
    return key;
  }
  return null;
}

/**
 * True for host variables that are unsafe to pass through by default because
 * they can alter shells, interpreters, compilers, loaders, or repo tooling.
 */
export function isDangerousHostEnvVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return false;
  }
  const upper = key.toUpperCase();
  if (HOST_DANGEROUS_ENV_KEYS.has(upper)) {
    return true;
  }
  return HOST_DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * True for inherited variables that must be stripped before OpenClaw launches a
 * host command. This is narrower than override blocking so normal proxy/CA env
 * can still flow from the operator's shell when already present.
 */
export function isDangerousHostInheritedEnvVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return false;
  }
  const upper = key.toUpperCase();
  if (HOST_DANGEROUS_INHERITED_ENV_KEYS.has(upper)) {
    return true;
  }
  return HOST_DANGEROUS_INHERITED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * True for variables that agents, plugins, or config are not allowed to inject
 * as request-scoped overrides, even when an inherited host value may be allowed.
 */
export function isDangerousHostEnvOverrideVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return false;
  }
  const upper = key.toUpperCase();
  if (HOST_DANGEROUS_OVERRIDE_ENV_KEYS.has(upper)) {
    return true;
  }
  return HOST_DANGEROUS_OVERRIDE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

function listNormalizedEnvEntries(
  source: Record<string, string | undefined>,
  options?: { portable?: boolean },
): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const [rawKey, value] of Object.entries(source)) {
    if (typeof value !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, options);
    if (!key) {
      continue;
    }
    entries.push([key, value]);
  }
  return entries;
}

function sanitizeHostEnvOverridesWithDiagnostics(params?: {
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): {
  acceptedOverrides?: Record<string, string>;
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
} {
  const overrides = params?.overrides ?? undefined;
  if (!overrides) {
    return {
      acceptedOverrides: undefined,
      rejectedOverrideBlockedKeys: [],
      rejectedOverrideInvalidKeys: [],
    };
  }

  const blockPathOverrides = params?.blockPathOverrides ?? true;
  const acceptedOverrides: Record<string, string> = {};
  const rejectedBlocked: string[] = [];
  const rejectedInvalid: string[] = [];

  for (const [rawKey, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      continue;
    }
    const normalized = normalizeHostOverrideEnvVarKey(rawKey);
    if (!normalized) {
      const candidate = rawKey.trim();
      rejectedInvalid.push(candidate || rawKey);
      continue;
    }
    const upper = normalized.toUpperCase();
    // PATH is part of command resolution and safe-bin checks; request-scoped
    // overrides would move the executable boundary after approval.
    if (blockPathOverrides && upper === "PATH") {
      rejectedBlocked.push(upper);
      continue;
    }
    if (isDangerousHostEnvVarName(upper) || isDangerousHostEnvOverrideVarName(upper)) {
      rejectedBlocked.push(upper);
      continue;
    }
    acceptedOverrides[normalized] = value;
  }

  return {
    acceptedOverrides,
    rejectedOverrideBlockedKeys: sortUniqueStrings(rejectedBlocked),
    rejectedOverrideInvalidKeys: sortUniqueStrings(rejectedInvalid),
  };
}

/**
 * Build the environment used for host command execution by stripping dangerous
 * inherited values, applying safe request overrides, and marking the child as an
 * OpenClaw-managed exec process.
 */
export function sanitizeHostExecEnvWithDiagnostics(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): HostExecEnvSanitizationResult {
  const baseEnv = params?.baseEnv ?? process.env;

  const merged: Record<string, string> = {};
  for (const [key, value] of listNormalizedEnvEntries(baseEnv)) {
    if (isDangerousHostInheritedEnvVarName(key)) {
      continue;
    }
    merged[key] = value;
  }

  const overrideResult = sanitizeHostEnvOverridesWithDiagnostics({
    overrides: params?.overrides ?? undefined,
    blockPathOverrides: params?.blockPathOverrides ?? true,
  });
  if (overrideResult.acceptedOverrides) {
    for (const [key, value] of Object.entries(overrideResult.acceptedOverrides)) {
      merged[key] = value;
    }
  }

  return {
    env: markOpenClawExecEnv(merged),
    rejectedOverrideBlockedKeys: overrideResult.rejectedOverrideBlockedKeys,
    rejectedOverrideInvalidKeys: overrideResult.rejectedOverrideInvalidKeys,
  };
}

/** Validate request override keys without merging them into the inherited env. */
export function inspectHostExecEnvOverrides(params?: {
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): HostExecEnvOverrideDiagnostics {
  const result = sanitizeHostEnvOverridesWithDiagnostics(params);
  return {
    rejectedOverrideBlockedKeys: result.rejectedOverrideBlockedKeys,
    rejectedOverrideInvalidKeys: result.rejectedOverrideInvalidKeys,
  };
}

/** Convenience wrapper for callers that only need the sanitized child env. */
export function sanitizeHostExecEnv(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): Record<string, string> {
  return sanitizeHostExecEnvWithDiagnostics(params).env;
}

/**
 * Filter system-run env overrides for execution surfaces. Shell-wrapper mode
 * only forwards presentation variables, because wrappers evaluate shell startup
 * paths before the final command runs.
 */
export function sanitizeSystemRunEnvOverrides(params?: {
  overrides?: Record<string, string> | null;
  shellWrapper?: boolean;
}): Record<string, string> | undefined {
  const overrides = params?.overrides ?? undefined;
  if (!overrides) {
    return undefined;
  }
  if (!params?.shellWrapper) {
    return overrides;
  }
  const filtered: Record<string, string> = {};
  for (const [key, value] of listNormalizedEnvEntries(overrides, { portable: true })) {
    if (!isShellWrapperAllowedOverrideEnvVarName(key)) {
      continue;
    }
    filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
