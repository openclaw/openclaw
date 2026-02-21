const HOST_DANGEROUS_ENV_KEY_VALUES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYLIB",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "GCONV_PATH",
  "IFS",
  "SSLKEYLOGFILE",
] as const;

export const HOST_DANGEROUS_ENV_KEYS = new Set<string>(HOST_DANGEROUS_ENV_KEY_VALUES);
export const HOST_DANGEROUS_ENV_PREFIXES = ["DYLD_", "LD_", "BASH_FUNC_"] as const;

export function isDangerousHostEnvVarName(key: string): boolean {
  const upper = key.toUpperCase();
  if (HOST_DANGEROUS_ENV_KEYS.has(upper)) {
    return true;
  }
  return HOST_DANGEROUS_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
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
    const key = rawKey.trim();
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
    const key = rawKey.trim();
    if (!key) {
      continue;
    }
    const upper = key.toUpperCase();
    // PATH is part of the security boundary (command resolution + safe-bin checks). Never allow
    // request-scoped PATH overrides from agents/gateways.
    if (blockPathOverrides && upper === "PATH") {
      continue;
    }
    if (isDangerousHostEnvVarName(upper)) {
      continue;
    }
    merged[key] = value;
  }

  return merged;
}
