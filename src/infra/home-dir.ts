import os from "node:os";
import path from "node:path";

function normalize(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "undefined" || trimmed === "null") {
    return undefined;
  }
  return trimmed;
}

export function resolveEffectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

export function resolveOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string | undefined {
  const raw = resolveRawOsHomeDir(env, homedir);
  return raw ? path.resolve(raw) : undefined;
}

function resolveRawHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const explicitHome = normalize(env.OPENCLAW_HOME);
  if (explicitHome) {
    if (explicitHome === "~" || explicitHome.startsWith("~/") || explicitHome.startsWith("~\\")) {
      const fallbackHome = resolveRawOsHomeDir(env, homedir);
      if (fallbackHome) {
        return explicitHome.replace(/^~(?=$|[\\/])/, fallbackHome);
      }
      return undefined;
    }
    return explicitHome;
  }

  return resolveRawOsHomeDir(env, homedir);
}

function resolveRawOsHomeDir(env: NodeJS.ProcessEnv, homedir: () => string): string | undefined {
  const envHome = normalize(env.HOME);
  if (envHome) {
    return envHome;
  }
  const userProfile = normalize(env.USERPROFILE);
  if (userProfile) {
    return userProfile;
  }
  return normalizeSafe(homedir);
}

function normalizeSafe(homedir: () => string): string | undefined {
  try {
    return normalize(homedir());
  } catch {
    return undefined;
  }
}

export function resolveRequiredHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveEffectiveHomeDir(env, homedir) ?? path.resolve(process.cwd());
}

export function resolveRequiredOsHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  return resolveOsHomeDir(env, homedir) ?? path.resolve(process.cwd());
}

export function expandHomePrefix(
  input: string,
  opts?: {
    home?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  if (!input.startsWith("~")) {
    return input;
  }
  const home =
    normalize(opts?.home) ??
    resolveEffectiveHomeDir(opts?.env ?? process.env, opts?.homedir ?? os.homedir);
  if (!home) {
    return input;
  }
  return input.replace(/^~(?=$|[\\/])/, home);
}

/**
 * Expand `${VAR}` and `$VAR` references in a string using the given environment.
 * Unknown variables are left as-is so the caller can detect misconfiguration.
 */
export function expandEnvVars(input: string, env: NodeJS.ProcessEnv = process.env): string {
  // Match ${VAR_NAME} (braced) and $VAR_NAME (unbraced, word-boundary delimited).
  return input.replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (match, braced, unbraced) => {
    const varName = braced ?? unbraced;
    const value = env[varName];
    return value !== undefined ? value : match;
  });
}

export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  const env = opts?.env ?? process.env;
  // Expand environment variable references before any other resolution.
  const envExpanded = expandEnvVars(trimmed, env);
  if (envExpanded.startsWith("~")) {
    const expanded = expandHomePrefix(envExpanded, {
      home: resolveRequiredHomeDir(env, opts?.homedir ?? os.homedir),
      env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(envExpanded);
}

export function resolveOsHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  const env = opts?.env ?? process.env;
  const envExpanded = expandEnvVars(trimmed, env);
  if (envExpanded.startsWith("~")) {
    const expanded = expandHomePrefix(envExpanded, {
      home: resolveRequiredOsHomeDir(env, opts?.homedir ?? os.homedir),
      env,
      homedir: opts?.homedir,
    });
    return path.resolve(expanded);
  }
  return path.resolve(envExpanded);
}
