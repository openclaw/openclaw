import HOST_ENV_SECURITY_POLICY_JSON from "./host-env-security-policy.json" with { type: "json" };

const PORTABLE_ENV_VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

type HostEnvSecurityPolicy = {
  blockedKeys: string[];
  blockedOverrideKeys?: string[];
  blockedPrefixes: string[];
};

const HOST_ENV_SECURITY_POLICY = HOST_ENV_SECURITY_POLICY_JSON as HostEnvSecurityPolicy;

export const HOST_DANGEROUS_ENV_KEY_VALUES: readonly string[] = Object.freeze(
  HOST_ENV_SECURITY_POLICY.blockedKeys.map((key) => key.toUpperCase()),
);
export const HOST_DANGEROUS_ENV_PREFIXES: readonly string[] = Object.freeze(
  HOST_ENV_SECURITY_POLICY.blockedPrefixes.map((prefix) => prefix.toUpperCase()),
);
export const HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES: readonly string[] = Object.freeze(
  (HOST_ENV_SECURITY_POLICY.blockedOverrideKeys ?? []).map((key) => key.toUpperCase()),
);
export const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES: readonly string[] = Object.freeze([
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
]);
export const HOST_DANGEROUS_ENV_KEYS = new Set<string>(HOST_DANGEROUS_ENV_KEY_VALUES);
export const HOST_DANGEROUS_OVERRIDE_ENV_KEYS = new Set<string>(
  HOST_DANGEROUS_OVERRIDE_ENV_KEY_VALUES,
);
export const HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS = new Set<string>(
  HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEY_VALUES,
);

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

export function isDangerousHostEnvOverrideVarName(rawKey: string): boolean {
  const key = normalizeEnvVarKey(rawKey);
  if (!key) {
    return false;
  }
  return HOST_DANGEROUS_OVERRIDE_ENV_KEYS.has(key.toUpperCase());
}

export function sanitizeHostExecEnv(params?: {
  baseEnv?: Record<string, string | undefined>;
  overrides?: Record<string, string> | null;
  blockPathOverrides?: boolean;
}): Record<string, string> {
  const baseEnv = params?.baseEnv ?? process.env;
  const overrides = params?.overrides ?? undefined;
  const blockPathOverrides = params?.blockPathOverrides ?? true;

  const merged: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(baseEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key || isDangerousHostEnvVarName(key)) {
      continue;
    }
    merged[key] = value;
  }

  if (!overrides) {
    return merged;
  }

  for (const [rawKey, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    const upper = key.toUpperCase();
    // PATH is part of the security boundary (command resolution + safe-bin checks). Never allow
    // request-scoped PATH overrides from agents/gateways.
    if (blockPathOverrides && upper === "PATH") {
      continue;
    }
    if (isDangerousHostEnvVarName(upper) || isDangerousHostEnvOverrideVarName(upper)) {
      continue;
    }
    merged[key] = value;
  }

  return merged;
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
  for (const [rawKey, value] of Object.entries(overrides)) {
    if (typeof value !== "string") {
      continue;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      continue;
    }
    if (!HOST_SHELL_WRAPPER_ALLOWED_OVERRIDE_ENV_KEYS.has(key.toUpperCase())) {
      continue;
    }
    filtered[key] = value;
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}
