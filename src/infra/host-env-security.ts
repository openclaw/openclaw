// Filters host environment variables before passing them to runtimes.
import { sortUniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { HOST_ENV_SECURITY_POLICY } from "./host-env-security-policy.js";
import {
  markOpenClawExecEnv,
  OPENCLAW_CHANNEL_CONTEXT_ENV_VAR,
  OPENCLAW_CLI_ENV_VAR,
} from "./openclaw-exec-env.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

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
const CARGO_TARGET_EXECUTABLE_OVERRIDE_ENV_KEY = /^CARGO_TARGET_[A-Z0-9_]+_(?:LINKER|RUNNER)$/;
const GIT_ALLOW_PROTOCOL_ENV_KEY = "GIT_ALLOW_PROTOCOL";
const GIT_PROTOCOL_FROM_USER_ENV_KEY = "GIT_PROTOCOL_FROM_USER";
const GIT_PROTOCOL_FROM_USER_DISABLED_VALUE = "0";
const GIT_DEFAULT_ALWAYS_ALLOWED_PROTOCOLS = new Set(["git", "http", "https", "ssh"]);

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

type HostExecEnvSanitizationResult = {
  env: Record<string, string>;
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
};

type HostExecEnvOverrideDiagnostics = {
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
};

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

export function isDangerousHostEnvOverrideVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return false;
  }
  const upper = key.toUpperCase();
  if (HOST_DANGEROUS_OVERRIDE_ENV_KEYS.has(upper)) {
    return true;
  }
  if (CARGO_TARGET_EXECUTABLE_OVERRIDE_ENV_KEY.test(upper)) {
    return true;
  }
  return HOST_DANGEROUS_OVERRIDE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

export type ConfiguredExecEnvKeyValidation =
  | { ok: true; key: string; caseFoldedKey: string }
  | { ok: false; reason: string };

/** Validates operator-configured agent exec env keys against the host security boundary. */
export function validateConfiguredExecEnvKey(rawKey: string): ConfiguredExecEnvKeyValidation {
  const key = normalizeEnvVarKey(rawKey, { portable: true });
  if (!key || key !== rawKey) {
    return { ok: false, reason: "must be a portable environment variable name" };
  }
  const upper = key.toUpperCase();
  if (isBlockedObjectKey(key)) {
    return { ok: false, reason: "uses a blocked prototype key" };
  }
  if (upper === "PATH") {
    return { ok: false, reason: "PATH is controlled by tools.exec.pathPrepend" };
  }
  if (upper === OPENCLAW_CLI_ENV_VAR || upper === OPENCLAW_CHANNEL_CONTEXT_ENV_VAR) {
    return { ok: false, reason: "is reserved by OpenClaw" };
  }
  if (isDangerousHostEnvVarName(upper) || isDangerousHostEnvOverrideVarName(upper)) {
    return { ok: false, reason: "is blocked by the host exec environment policy" };
  }
  return { ok: true, key, caseFoldedKey: upper };
}

/** Sets an env value while making later layers win across case variants on every platform. */
export function setCaseInsensitiveEnvValue(
  env: Record<string, string>,
  key: string,
  value: string,
): void {
  const foldedKey = key.toUpperCase();
  for (const existingKey of Object.keys(env)) {
    if (existingKey !== key && existingKey.toUpperCase() === foldedKey) {
      delete env[existingKey];
    }
  }
  Object.defineProperty(env, key, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  });
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

function isPermissiveGitProtocolFromUserValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (/^[+-]?\d+$/.test(normalized) && !/^[+-]?0+$/.test(normalized)) {
    return true;
  }
  return false;
}

function sanitizeInheritedGitAllowProtocolValue(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }
  const safeProtocols = normalized
    .split(":")
    .filter((protocol) => GIT_DEFAULT_ALWAYS_ALLOWED_PROTOCOLS.has(protocol));
  return safeProtocols.join(":");
}

export function sanitizeHostInheritedEnvEntry(
  rawKey: string,
  value: string,
): [string, string] | null {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return null;
  }
  if (isBlockedObjectKey(key) || key.toUpperCase() === OPENCLAW_CHANNEL_CONTEXT_ENV_VAR) {
    return null;
  }
  // Preserve inherited Git allowlists without widening malformed or unsafe entries by deletion.
  // Protocols outside Git's safe default set are removed instead of being passed through.
  if (key.toUpperCase() === GIT_ALLOW_PROTOCOL_ENV_KEY) {
    return [key, sanitizeInheritedGitAllowProtocolValue(value)];
  }
  // Preserve non-permissive Git boolean values. Permissive values must become explicit `0`
  // because Git's unset default still permits protocols with policy `user`.
  if (key.toUpperCase() === GIT_PROTOCOL_FROM_USER_ENV_KEY) {
    return [
      key,
      isPermissiveGitProtocolFromUserValue(value) ? GIT_PROTOCOL_FROM_USER_DISABLED_VALUE : value,
    ];
  }
  if (isDangerousHostInheritedEnvVarName(key)) {
    return null;
  }
  return [key, value];
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
    if (isBlockedObjectKey(normalized)) {
      rejectedBlocked.push(normalized);
      continue;
    }
    // PATH is part of the security boundary (command resolution + safe-bin checks). Never allow
    // request-scoped PATH overrides from agents/gateways.
    if (blockPathOverrides && upper === "PATH") {
      rejectedBlocked.push(upper);
      continue;
    }
    if (isDangerousHostEnvVarName(upper) || isDangerousHostEnvOverrideVarName(upper)) {
      rejectedBlocked.push(upper);
      continue;
    }
    setCaseInsensitiveEnvValue(acceptedOverrides, normalized, value);
  }

  return {
    acceptedOverrides,
    rejectedOverrideBlockedKeys: sortUniqueStrings(rejectedBlocked),
    rejectedOverrideInvalidKeys: sortUniqueStrings(rejectedInvalid),
  };
}

export function sanitizeHostExecEnvWithDiagnostics(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): HostExecEnvSanitizationResult {
  const baseEnv = params?.baseEnv ?? process.env;

  const merged: Record<string, string> = {};
  for (const [key, value] of listNormalizedEnvEntries(baseEnv)) {
    const sanitizedEntry = sanitizeHostInheritedEnvEntry(key, value);
    if (!sanitizedEntry) {
      continue;
    }
    const [sanitizedKey, sanitizedValue] = sanitizedEntry;
    Object.defineProperty(merged, sanitizedKey, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: sanitizedValue,
    });
  }

  const overrideResult = sanitizeHostEnvOverridesWithDiagnostics({
    overrides: params?.overrides ?? undefined,
    blockPathOverrides: params?.blockPathOverrides ?? true,
  });
  if (overrideResult.acceptedOverrides) {
    for (const [key, value] of Object.entries(overrideResult.acceptedOverrides)) {
      setCaseInsensitiveEnvValue(merged, key, value);
    }
  }

  return {
    env: markOpenClawExecEnv(merged),
    rejectedOverrideBlockedKeys: overrideResult.rejectedOverrideBlockedKeys,
    rejectedOverrideInvalidKeys: overrideResult.rejectedOverrideInvalidKeys,
  };
}

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

export function sanitizeHostExecEnv(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): Record<string, string> {
  return sanitizeHostExecEnvWithDiagnostics(params).env;
}

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
