// Builds npm environment overrides for safe project-local installs.
import { spawnSync } from "node:child_process";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeStatSync } from "@openclaw/fs-safe/path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveSafeChildProcessInvocation } from "../process/windows-command.js";
import { resolveNpmCommand } from "./npm-command.js";
import { tryProcessCwd } from "./safe-cwd.js";
import { UPDATE_NETWORK_TIMEOUT_MS } from "./update-network-budget.js";

/** Options that scope npm config and cache paths for project-local installs. */
export type NpmProjectInstallEnvOptions = NpmConfigScope & {
  cacheDir?: string;
};

const NPM_CONFIG_SCRIPT_SHELL_KEYS = ["NPM_CONFIG_SCRIPT_SHELL", "npm_config_script_shell"];

const NPM_CONFIG_KEYS_TO_RESET = new Set([
  "npm_config_cache",
  "npm_config_dry_run",
  "npm_config_global",
  "npm_config_include_workspace_root",
  "npm_config_ignore_scripts",
  "npm_config_location",
  "npm_config_legacy_peer_deps",
  "npm_config_prefix",
  "npm_config_strict_peer_deps",
  "npm_config_workspace",
  "npm_config_workspaces",
]);

const NPM_FRESHNESS_BYPASS_KEYS = [
  "NPM_CONFIG_BEFORE",
  "npm_config_before",
  "NPM_CONFIG_MIN_RELEASE_AGE",
  "npm_config_min_release_age",
  "NPM_CONFIG_MIN-RELEASE-AGE",
  "npm_config_min-release-age",
] as const;

type NpmFreshnessBypassMode = "before" | "min-release-age";

export type NpmConfigScope = {
  npmConfigCwd?: string;
  npmConfigPrefix?: string | null;
};

const NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS = ["PATH", "Path", "PATHEXT", "SystemRoot", "ComSpec"];
const NPM_GLOBAL_CONFIG_PATH_CACHE = new Map<string, string | null>();
const NPM_GLOBAL_CONFIG_PATH_CACHE_ENV_KEYS = [
  ...NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS,
  "NPM_CONFIG_GLOBALCONFIG",
  "npm_config_globalconfig",
  "NPM_CONFIG_PREFIX",
  "npm_config_prefix",
  "NPM_CONFIG_USERCONFIG",
  "npm_config_userconfig",
  "HOME",
  "PREFIX",
  "USERPROFILE",
] as const;

function resolveEnvPath(
  env: NodeJS.ProcessEnv,
  primaryKey: string,
  fallbackKey: string,
): string | null {
  const raw = env[primaryKey]?.trim() || env[fallbackKey]?.trim();
  return raw ? resolveNpmConfigPath(raw, env) : null;
}

function resolveHomeNpmrc(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ".npmrc");
}

function replaceNpmEnvRefs(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(
    /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/gu,
    (original, escapes, name, modifier) => {
      const fallback = modifier === "?" ? "" : `\${${name}}`;
      const resolved = env[name] !== undefined ? env[name] : fallback;
      if (escapes.length % 2) {
        return original.slice((escapes.length + 1) / 2);
      }
      return `${escapes.slice(escapes.length / 2)}${resolved}`;
    },
  );
}

function resolveNpmConfigPath(rawPath: string, env: NodeJS.ProcessEnv): string {
  const expanded = replaceNpmEnvRefs(rawPath, env);
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || os.homedir();
  const homePattern = process.platform === "win32" ? /^~(\/|\\)/u : /^~\//u;
  return homePattern.test(expanded) && home
    ? path.resolve(home, expanded.slice(2))
    : path.resolve(expanded);
}

function createNpmConfigPathProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const probeEnv = { ...env };
  for (const key of NPM_FRESHNESS_BYPASS_KEYS) {
    delete probeEnv[key];
  }
  for (const key of NPM_CONFIG_PATH_PROBE_PARENT_ENV_KEYS) {
    if (probeEnv[key] == null && process.env[key] != null) {
      probeEnv[key] = process.env[key];
    }
  }
  return probeEnv;
}

function runNpmConfigProbe(params: {
  args: readonly string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): string {
  const invocation = resolveSafeChildProcessInvocation({
    argv: resolveNpmCommand(params.args),
    cwd: params.cwd,
    env: params.env,
  });
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: params.cwd,
    encoding: "utf-8",
    env: params.env,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: params.timeoutMs,
    windowsHide: invocation.windowsHide,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`npm config probe exited with status ${result.status ?? "unknown"}`);
  }
  return result.stdout;
}

function readNpmGlobalConfigPath(env: NodeJS.ProcessEnv, scope: NpmConfigScope): string | null {
  const scopedGlobalConfig = resolveScopedGlobalNpmrc(scope);
  if (scopedGlobalConfig) {
    return scopedGlobalConfig;
  }
  const configuredGlobalConfig = resolveEnvPath(
    env,
    "NPM_CONFIG_GLOBALCONFIG",
    "npm_config_globalconfig",
  );
  if (configuredGlobalConfig) {
    return configuredGlobalConfig;
  }
  const configuredPrefix = resolveEnvPath(env, "NPM_CONFIG_PREFIX", "npm_config_prefix");
  if (configuredPrefix) {
    return path.join(configuredPrefix, "etc", "npmrc");
  }
  const cacheKey = buildNpmGlobalConfigPathCacheKey(env, scope);
  if (NPM_GLOBAL_CONFIG_PATH_CACHE.has(cacheKey)) {
    return NPM_GLOBAL_CONFIG_PATH_CACHE.get(cacheKey) ?? null;
  }
  try {
    const raw = runNpmConfigProbe({
      args: ["config", "get", "globalconfig"],
      env: {
        ...createNpmConfigPathProbeEnv(env),
        ...(scope.npmConfigPrefix ? { npm_config_prefix: scope.npmConfigPrefix } : {}),
      },
      timeoutMs: 2_000,
    }).trim();
    const resolved = raw && raw !== "null" && raw !== "undefined" ? raw : null;
    NPM_GLOBAL_CONFIG_PATH_CACHE.set(cacheKey, resolved);
    return resolved;
  } catch {
    NPM_GLOBAL_CONFIG_PATH_CACHE.set(cacheKey, null);
    return null;
  }
}

function buildNpmGlobalConfigPathCacheKey(env: NodeJS.ProcessEnv, scope: NpmConfigScope): string {
  const configFiles = uniqueStrings(
    [
      resolveScopedProjectNpmrc(scope),
      resolveEnvPath(env, "NPM_CONFIG_USERCONFIG", "npm_config_userconfig") ??
        resolveHomeNpmrc(env),
      resolveEnvPath(env, "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"),
      resolveScopedGlobalNpmrc(scope),
    ].filter((file): file is string => Boolean(file)),
  );
  return JSON.stringify({
    cwd: scope.npmConfigCwd?.trim() || tryProcessCwd() || "",
    prefix: scope.npmConfigPrefix?.trim() ?? "",
    env: Object.fromEntries(
      NPM_GLOBAL_CONFIG_PATH_CACHE_ENV_KEYS.map((key) => [key, env[key] ?? process.env[key] ?? ""]),
    ),
    configFiles: configFiles.map((filePath) => {
      const stat = safeStatSync(filePath);
      return { path: filePath, signature: stat ? `${stat.mtimeMs}:${stat.size}` : "missing" };
    }),
  });
}

function resolveScopedProjectNpmrc(scope: NpmConfigScope): string | null {
  const cwd = scope.npmConfigCwd?.trim() || tryProcessCwd();
  return cwd ? path.join(cwd, ".npmrc") : null;
}

function resolveScopedGlobalNpmrc(scope: NpmConfigScope): string | null {
  const prefix = scope.npmConfigPrefix?.trim();
  return prefix ? path.join(prefix, "etc", "npmrc") : null;
}

function hasRawNpmConfigKey(
  env: NodeJS.ProcessEnv,
  key: string,
  scope: NpmConfigScope = {},
): boolean {
  const userNpmrc =
    resolveEnvPath(env, "NPM_CONFIG_USERCONFIG", "npm_config_userconfig") ?? resolveHomeNpmrc(env);
  const files = [
    resolveScopedProjectNpmrc(scope),
    userNpmrc,
    resolveEnvPath(env, "NPM_CONFIG_GLOBALCONFIG", "npm_config_globalconfig"),
    resolveScopedGlobalNpmrc(scope),
    readNpmGlobalConfigPath(env, scope),
  ];
  return uniqueStrings(files.filter((file): file is string => Boolean(file))).some((file) =>
    hasNpmrcConfigKey(file, key),
  );
}

function hasNpmrcConfigKey(filePath: string, key: string): boolean {
  try {
    const raw = fsSync.readFileSync(filePath, "utf-8");
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`^\\s*${escapedKey}\\s*=`, "imu");
    return pattern.test(raw);
  } catch {
    return false;
  }
}

function hasNpmEnvConfigKey(env: NodeJS.ProcessEnv, key: string): boolean {
  return Object.entries(env).some(([envKey, value]) => {
    if (!/^npm_config_/iu.test(envKey) || !value?.trim()) {
      return false;
    }
    const normalized = envKey
      .slice("npm_config_".length)
      .replace(/(?!^)_/gu, "-")
      .toLowerCase();
    return normalized === key;
  });
}

/** Finds keys npm resolves from explicit config layers rather than built-in defaults. */
export function findExplicitNpmConfigKeys(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
  scope: NpmConfigScope = {},
): Set<string> {
  const found = new Set(keys.filter((key) => hasNpmEnvConfigKey(env, key)));
  const remaining = keys.filter((key) => !found.has(key));
  if (remaining.length === 0) {
    return found;
  }

  const cwd = scope.npmConfigCwd?.trim() || tryProcessCwd() || undefined;
  const probeEnv = {
    ...createNpmConfigPathProbeEnv(env),
    ...(scope.npmConfigPrefix ? { npm_config_prefix: scope.npmConfigPrefix } : {}),
  };
  try {
    const raw = runNpmConfigProbe({
      args: ["config", "list", "--location=project", "--json=false", "--long=false"],
      cwd,
      env: probeEnv,
      timeoutMs: 5_000,
    });
    const installConfig = raw.split(/^; "publishConfig" from /mu, 1)[0] ?? raw;
    for (const key of remaining) {
      const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      if (new RegExp(`^${escapedKey}\\s*=`, "mu").test(installConfig)) {
        found.add(key);
      }
    }
  } catch {
    for (const key of remaining) {
      found.add(key);
    }
  }
  return found;
}

function resolveNpmFreshnessBypassMode(
  env: NodeJS.ProcessEnv,
  scope: NpmConfigScope,
): NpmFreshnessBypassMode {
  if (process.platform === "win32") {
    return "before";
  }
  if (hasRawNpmConfigKey(env, "min-release-age", scope)) {
    return "min-release-age";
  }
  return hasRawNpmConfigKey(env, "before", scope) ? "before" : "min-release-age";
}

/**
 * Builds npm args that bypass host freshness policies for OpenClaw-managed installs.
 * Existing npmrc policy decides whether `before` or `min-release-age` is safer.
 */
export function createNpmFreshnessBypassArgs(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
  scope: NpmConfigScope = {},
): string[] {
  if (resolveNpmFreshnessBypassMode(env, scope) === "min-release-age") {
    return ["--min-release-age=0"];
  }
  return [`--before=${now.toISOString()}`];
}

/** Applies the same npm freshness bypass policy through environment variables. */
export function applyNpmFreshnessBypassEnv(
  env: NodeJS.ProcessEnv,
  now = new Date(),
  scope: NpmConfigScope = {},
): void {
  const before =
    resolveNpmFreshnessBypassMode(env, scope) === "before" ? now.toISOString() : undefined;
  for (const key of NPM_FRESHNESS_BYPASS_KEYS) {
    if (process.platform === "win32" && key.includes("-")) {
      delete env[key];
      continue;
    }
    env[key] = "";
  }
  if (before !== undefined) {
    env.npm_config_before = before;
  } else {
    env.npm_config_min_release_age = "0";
  }
}

/**
 * Creates npm env for project-local installs, clearing global/workspace config
 * and adding fetch, freshness, cache, and POSIX script-shell defaults.
 */
export function createNpmProjectInstallEnv(
  env: NodeJS.ProcessEnv,
  options: NpmProjectInstallEnvOptions = {},
  now = new Date(),
): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  for (const key of Object.keys(nextEnv)) {
    if (NPM_CONFIG_KEYS_TO_RESET.has(key.toLowerCase())) {
      delete nextEnv[key];
    }
  }
  const installEnv: NodeJS.ProcessEnv = {
    ...nextEnv,
    npm_config_dry_run: "false",
    npm_config_fetch_retries: nextEnv.npm_config_fetch_retries ?? "5",
    npm_config_fetch_retry_maxtimeout: nextEnv.npm_config_fetch_retry_maxtimeout ?? "120000",
    npm_config_fetch_retry_mintimeout: nextEnv.npm_config_fetch_retry_mintimeout ?? "10000",
    npm_config_fetch_timeout: nextEnv.npm_config_fetch_timeout ?? String(UPDATE_NETWORK_TIMEOUT_MS),
    npm_config_global: "false",
    npm_config_location: "project",
    npm_config_package_lock: "false",
    npm_config_save: "false",
    ...(options.cacheDir ? { npm_config_cache: options.cacheDir } : {}),
  };
  applyNpmFreshnessBypassEnv(installEnv, now, options);
  applyPosixNpmScriptShellEnv(installEnv);
  return installEnv;
}

/** Sets npm's script-shell env only when the caller has not configured one. */
export function applyPosixNpmScriptShellEnv(env: NodeJS.ProcessEnv): void {
  if (
    NPM_CONFIG_SCRIPT_SHELL_KEYS.some((key) => Boolean(env[key]?.trim())) ||
    process.platform === "win32"
  ) {
    return;
  }
  if (fsSync.existsSync("/bin/sh")) {
    env.NPM_CONFIG_SCRIPT_SHELL = "/bin/sh";
  } else {
    const shell = env.SHELL?.trim();
    if (shell && path.isAbsolute(shell) && fsSync.existsSync(shell)) {
      env.NPM_CONFIG_SCRIPT_SHELL = shell;
    }
  }
}
