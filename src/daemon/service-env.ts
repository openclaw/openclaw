import os from "node:os";
import path from "node:path";
import { VERSION } from "../version.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";

export type MinimalServicePathOptions = {
  platform?: NodeJS.Platform;
  extraDirs?: string[];
  home?: string;
  env?: Record<string, string | undefined>;
};

type BuildServicePathOptions = MinimalServicePathOptions & {
  env?: Record<string, string | undefined>;
};

const SERVICE_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const;

function readServiceProxyEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of SERVICE_PROXY_ENV_KEYS) {
    const value = env[key];
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    out[key] = trimmed;
  }
  return out;
}

function addNonEmptyDir(dirs: string[], dir: string | undefined): void {
  if (dir) {
    dirs.push(dir);
  }
}

function appendSubdir(base: string | undefined, subdir: string): string | undefined {
  if (!base) {
    return undefined;
  }
  return base.endsWith(`/${subdir}`) ? base : path.posix.join(base, subdir);
}

function addCommonUserBinDirs(dirs: string[], home: string): void {
  dirs.push(`${home}/.local/bin`);
  dirs.push(`${home}/.npm-global/bin`);
  dirs.push(`${home}/bin`);
  dirs.push(`${home}/.volta/bin`);
  dirs.push(`${home}/.asdf/shims`);
  dirs.push(`${home}/.bun/bin`);
}

function addCommonEnvConfiguredBinDirs(
  dirs: string[],
  env: Record<string, string | undefined> | undefined,
): void {
  addNonEmptyDir(dirs, env?.PNPM_HOME);
  addNonEmptyDir(dirs, appendSubdir(env?.NPM_CONFIG_PREFIX, "bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.BUN_INSTALL, "bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.VOLTA_HOME, "bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.ASDF_DATA_DIR, "shims"));
}

function resolveSystemPathDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  }
  if (platform === "linux") {
    return ["/usr/local/bin", "/usr/bin", "/bin"];
  }
  return [];
}

/**
 * Resolve common user bin directories for macOS.
 * These are paths where npm global installs and node version managers typically place binaries.
 *
 * Key differences from Linux:
 * - fnm: macOS uses ~/Library/Application Support/fnm (not ~/.local/share/fnm)
 * - pnpm: macOS uses ~/Library/pnpm (not ~/.local/share/pnpm)
 */
export function resolveDarwinUserBinDirs(
  home: string | undefined,
  env?: Record<string, string | undefined>,
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];

  // Env-configured bin roots (override defaults when present).
  // Note: FNM_DIR on macOS defaults to ~/Library/Application Support/fnm
  // Note: PNPM_HOME on macOS defaults to ~/Library/pnpm
  addCommonEnvConfiguredBinDirs(dirs, env);
  // nvm: no stable default path, relies on env or user's shell config
  // User must set NVM_DIR and source nvm.sh for it to work
  addNonEmptyDir(dirs, env?.NVM_DIR);
  // fnm: use aliases/default (not current)
  addNonEmptyDir(dirs, appendSubdir(env?.FNM_DIR, "aliases/default/bin"));
  // pnpm: binary is directly in PNPM_HOME (not in bin subdirectory)

  // Common user bin directories
  addCommonUserBinDirs(dirs, home);

  // Node version managers - macOS specific paths
  // nvm: no stable default path, depends on user's shell configuration
  // fnm: macOS default is ~/Library/Application Support/fnm, not ~/.fnm
  dirs.push(`${home}/Library/Application Support/fnm/aliases/default/bin`); // fnm default
  dirs.push(`${home}/.fnm/aliases/default/bin`); // fnm if customized to ~/.fnm
  // pnpm: macOS default is ~/Library/pnpm, not ~/.local/share/pnpm
  dirs.push(`${home}/Library/pnpm`); // pnpm default
  dirs.push(`${home}/.local/share/pnpm`); // pnpm XDG fallback

  return dirs;
}

/**
 * Resolve common user bin directories for Linux.
 * These are paths where npm global installs and node version managers typically place binaries.
 */
export function resolveLinuxUserBinDirs(
  home: string | undefined,
  env?: Record<string, string | undefined>,
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];

  // Env-configured bin roots (override defaults when present).
  addCommonEnvConfiguredBinDirs(dirs, env);
  addNonEmptyDir(dirs, appendSubdir(env?.NVM_DIR, "current/bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.FNM_DIR, "current/bin"));

  // Common user bin directories
  addCommonUserBinDirs(dirs, home);

  // Node version managers
  dirs.push(`${home}/.nvm/current/bin`); // nvm with current symlink
  dirs.push(`${home}/.fnm/current/bin`); // fnm
  dirs.push(`${home}/.local/share/pnpm`); // pnpm global bin

  return dirs;
}

export function getMinimalServicePathParts(options: MinimalServicePathOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return [];
  }

  const parts: string[] = [];
  const extraDirs = options.extraDirs ?? [];
  const systemDirs = resolveSystemPathDirs(platform);

  // Add user bin directories for version managers (npm global, nvm, fnm, volta, etc.)
  const userDirs =
    platform === "linux"
      ? resolveLinuxUserBinDirs(options.home, options.env)
      : platform === "darwin"
        ? resolveDarwinUserBinDirs(options.home, options.env)
        : [];

  const add = (dir: string) => {
    if (!dir) {
      return;
    }
    if (!parts.includes(dir)) {
      parts.push(dir);
    }
  };

  for (const dir of extraDirs) {
    add(dir);
  }
  // User dirs first so user-installed binaries take precedence
  for (const dir of userDirs) {
    add(dir);
  }
  for (const dir of systemDirs) {
    add(dir);
  }

  return parts;
}

export function getMinimalServicePathPartsFromEnv(options: BuildServicePathOptions = {}): string[] {
  const env = options.env ?? process.env;
  return getMinimalServicePathParts({
    ...options,
    home: options.home ?? env.HOME,
    env,
  });
}

export function buildMinimalServicePath(options: BuildServicePathOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    return env.PATH ?? "";
  }

  return getMinimalServicePathPartsFromEnv({ ...options, env }).join(path.posix.delimiter);
}

export function buildServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  port: number;
  token?: string;
  launchdLabel?: string;
  platform?: NodeJS.Platform;
}): Record<string, string | undefined> {
  const { env, port, token, launchdLabel } = params;
  const platform = params.platform ?? process.platform;
  const profile = env.OPENCLAW_PROFILE;
  const resolvedLaunchdLabel =
    launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : undefined);
  const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  // Keep a usable temp directory for supervised services even when the host env omits TMPDIR.
  const tmpDir = env.TMPDIR?.trim() || os.tmpdir();
  const proxyEnv = readServiceProxyEnvironment(env);
  // On macOS, launchd services don't inherit the shell environment, so Node's undici/fetch
  // cannot locate the system CA bundle. Default to /etc/ssl/cert.pem so TLS verification
  // works correctly when running as a LaunchAgent without extra user configuration.
  const nodeCaCerts =
    env.NODE_EXTRA_CA_CERTS ?? (platform === "darwin" ? "/etc/ssl/cert.pem" : undefined);
  return {
    HOME: env.HOME,
    TMPDIR: tmpDir,
    PATH: buildMinimalServicePath({ env }),
    ...proxyEnv,
    NODE_EXTRA_CA_CERTS: nodeCaCerts,
    OPENCLAW_PROFILE: profile,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
    OPENCLAW_SYSTEMD_UNIT: systemdUnit,
    OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
    OPENCLAW_SERVICE_VERSION: VERSION,
  };
}

export function buildNodeServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
}): Record<string, string | undefined> {
  const { env } = params;
  const platform = params.platform ?? process.platform;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  const tmpDir = env.TMPDIR?.trim() || os.tmpdir();
  const proxyEnv = readServiceProxyEnvironment(env);
  // On macOS, launchd services don't inherit the shell environment, so Node's undici/fetch
  // cannot locate the system CA bundle. Default to /etc/ssl/cert.pem so TLS verification
  // works correctly when running as a LaunchAgent without extra user configuration.
  const nodeCaCerts =
    env.NODE_EXTRA_CA_CERTS ?? (platform === "darwin" ? "/etc/ssl/cert.pem" : undefined);
  return {
    HOME: env.HOME,
    TMPDIR: tmpDir,
    PATH: buildMinimalServicePath({ env }),
    ...proxyEnv,
    NODE_EXTRA_CA_CERTS: nodeCaCerts,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_LAUNCHD_LABEL: resolveNodeLaunchAgentLabel(),
    OPENCLAW_SYSTEMD_UNIT: resolveNodeSystemdServiceName(),
    OPENCLAW_WINDOWS_TASK_NAME: resolveNodeWindowsTaskName(),
    OPENCLAW_TASK_SCRIPT_NAME: NODE_WINDOWS_TASK_SCRIPT_NAME,
    OPENCLAW_LOG_PREFIX: "node",
    OPENCLAW_SERVICE_MARKER: NODE_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: NODE_SERVICE_KIND,
    OPENCLAW_SERVICE_VERSION: VERSION,
  };
}
