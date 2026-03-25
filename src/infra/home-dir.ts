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

function normalizeEnvValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return normalize(value);
}

function expandEnvPlaceholders(
  input: string,
  env: NodeJS.ProcessEnv,
  expandTilde?: (value: string) => string,
): string {
  return input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (token, braced, bare) => {
      const key = String(braced ?? bare ?? "");
      if (!key) {
        return token;
      }
      if (!Object.hasOwn(env, key)) {
        return token;
      }
      // 空字符串环境变量按未设置处理，保留原占位符，避免把路径段替换成空值。
      const resolved = normalizeEnvValue(env[key]);
      if (!resolved) {
        return token;
      }
      return expandTilde ? expandTilde(resolved) : resolved;
    },
  );
}

export function resolveHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const env = opts?.env ?? process.env;
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  const home = resolveRequiredHomeDir(env, opts?.homedir ?? os.homedir);
  const osHome = resolveRequiredOsHomeDir(env, opts?.homedir ?? os.homedir);
  const expandedEnv = expandEnvPlaceholders(trimmed, env, (value) =>
    expandHomePrefix(value, {
      home: osHome,
      env,
      homedir: opts?.homedir,
    }),
  );
  if (expandedEnv.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(expandedEnv, {
        home,
        env,
        homedir: opts?.homedir,
      }),
    );
  }
  return path.resolve(expandedEnv);
}

export function resolveOsHomeRelativePath(
  input: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): string {
  const env = opts?.env ?? process.env;
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  const home = resolveRequiredOsHomeDir(env, opts?.homedir ?? os.homedir);
  const expandedEnv = expandEnvPlaceholders(trimmed, env, (value) =>
    expandHomePrefix(value, {
      home,
      env,
      homedir: opts?.homedir,
    }),
  );
  if (expandedEnv.startsWith("~")) {
    return path.resolve(
      expandHomePrefix(expandedEnv, {
        home,
        env,
        homedir: opts?.homedir,
      }),
    );
  }
  return path.resolve(expandedEnv);
}
