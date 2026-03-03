import fs from "node:fs";
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
  requireExistingUserDirs?: boolean;
};

type BuildServicePathOptions = MinimalServicePathOptions & {
  env?: Record<string, string | undefined>;
};

type SharedServiceEnvironmentFields = {
  stateDir: string | undefined;
  configPath: string | undefined;
  tmpDir: string;
  minimalPath: string;
  proxyEnv: Record<string, string | undefined>;
  nodeCaCerts: string | undefined;
  nodeUseSystemCa: string | undefined;
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

function addDir(dirs: string[], dir: string, requireExistingUserDirs: boolean): void {
  if (!requireExistingUserDirs || fs.existsSync(dir)) {
    dirs.push(dir);
  }
}

function appendSubdir(base: string | undefined, subdir: string): string | undefined {
  if (!base) {
    return undefined;
  }
  return base.endsWith(`/${subdir}`) ? base : path.posix.join(base, subdir);
}

function addCommonUserBinDirs(
  dirs: string[],
  home: string,
  requireExistingUserDirs: boolean,
): void {
  addDir(dirs, `${home}/.local/bin`, requireExistingUserDirs);
  addDir(dirs, `${home}/.npm-global/bin`, requireExistingUserDirs);
  addDir(dirs, `${home}/bin`, requireExistingUserDirs);
  addDir(dirs, `${home}/.volta/bin`, requireExistingUserDirs);
  addDir(dirs, `${home}/.asdf/shims`, requireExistingUserDirs);
  addDir(dirs, `${home}/.bun/bin`, requireExistingUserDirs);
}

function addCommonEnvConfiguredBinDirs(
  dirs: string[],
  env: Record<string, string | undefined> | undefined,
  requireExistingUserDirs: boolean,
): void {
  const configuredDirs = [
    env?.PNPM_HOME,
    appendSubdir(env?.NPM_CONFIG_PREFIX, "bin"),
    appendSubdir(env?.BUN_INSTALL, "bin"),
    appendSubdir(env?.VOLTA_HOME, "bin"),
    appendSubdir(env?.ASDF_DATA_DIR, "shims"),
  ];
  for (const dir of configuredDirs) {
    if (!dir) {
      continue;
    }
    addDir(dirs, dir, requireExistingUserDirs);
  }
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
  requireExistingUserDirs = false,
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];

  // Env-configured bin roots (override defaults when present).
  // Note: FNM_DIR on macOS defaults to ~/Library/Application Support/fnm
  // Note: PNPM_HOME on macOS defaults to ~/Library/pnpm
  addCommonEnvConfiguredBinDirs(dirs, env, requireExistingUserDirs);
  // nvm: no stable default path, relies on env or user's shell config
  // User must set NVM_DIR and source nvm.sh for it to work
  if (env?.NVM_DIR) {
    addDir(dirs, env.NVM_DIR, requireExistingUserDirs);
  }
  // fnm: use aliases/default (not current)
  const fnmAliasesDir = appendSubdir(env?.FNM_DIR, "aliases/default/bin");
  if (fnmAliasesDir) {
    addDir(dirs, fnmAliasesDir, requireExistingUserDirs);
  }
  // pnpm: binary is directly in PNPM_HOME (not in bin subdirectory)

  // Common user bin directories
  addCommonUserBinDirs(dirs, home, requireExistingUserDirs);

  // Node version managers - macOS specific paths
  // nvm: no stable default path, depends on user's shell configuration
  // fnm: macOS default is ~/Library/Application Support/fnm, not ~/.fnm
  addDir(
    dirs,
    `${home}/Library/Application Support/fnm/aliases/default/bin`,
    requireExistingUserDirs,
  ); // fnm default
  addDir(dirs, `${home}/.fnm/aliases/default/bin`, requireExistingUserDirs); // fnm if customized to ~/.fnm
  // pnpm: macOS default is ~/Library/pnpm, not ~/.local/share/pnpm
  addDir(dirs, `${home}/Library/pnpm`, requireExistingUserDirs); // pnpm default
  addDir(dirs, `${home}/.local/share/pnpm`, requireExistingUserDirs); // pnpm XDG fallback

  return dirs;
}

/**
 * Resolve common user bin directories for Linux.
 * These are paths where npm global installs and node version managers typically place binaries.
 */
export function resolveLinuxUserBinDirs(
  home: string | undefined,
  env?: Record<string, string | undefined>,
  requireExistingUserDirs = false,
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];

  // Env-configured bin roots (override defaults when present).
  addCommonEnvConfiguredBinDirs(dirs, env, requireExistingUserDirs);
  const nvmCurrentDir = appendSubdir(env?.NVM_DIR, "current/bin");
  if (nvmCurrentDir) {
    addDir(dirs, nvmCurrentDir, requireExistingUserDirs);
  }
  const fnmCurrentDir = appendSubdir(env?.FNM_DIR, "current/bin");
  if (fnmCurrentDir) {
    addDir(dirs, fnmCurrentDir, requireExistingUserDirs);
  }

  // Common user bin directories
  addCommonUserBinDirs(dirs, home, requireExistingUserDirs);

  // Node version managers
  addDir(dirs, `${home}/.nvm/current/bin`, requireExistingUserDirs); // nvm with current symlink
  addDir(dirs, `${home}/.fnm/current/bin`, requireExistingUserDirs); // fnm
  addDir(dirs, `${home}/.local/share/pnpm`, requireExistingUserDirs); // pnpm global bin

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
      ? resolveLinuxUserBinDirs(options.home, options.env, options.requireExistingUserDirs)
      : platform === "darwin"
        ? resolveDarwinUserBinDirs(options.home, options.env, options.requireExistingUserDirs)
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
  const sharedEnv = resolveSharedServiceEnvironmentFields(env, platform);
  const profile = env.OPENCLAW_PROFILE;
  const resolvedLaunchdLabel =
    launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : undefined);
  const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_PROFILE: profile,
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
  const sharedEnv = resolveSharedServiceEnvironmentFields(env, platform);
  const gatewayToken =
    env.OPENCLAW_GATEWAY_TOKEN?.trim() || env.CLAWDBOT_GATEWAY_TOKEN?.trim() || undefined;
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
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

function buildCommonServiceEnvironment(
  env: Record<string, string | undefined>,
  sharedEnv: SharedServiceEnvironmentFields,
): Record<string, string | undefined> {
  return {
    HOME: env.HOME,
    TMPDIR: sharedEnv.tmpDir,
    PATH: sharedEnv.minimalPath,
    ...sharedEnv.proxyEnv,
    NODE_EXTRA_CA_CERTS: sharedEnv.nodeCaCerts,
    NODE_USE_SYSTEM_CA: sharedEnv.nodeUseSystemCa,
    OPENCLAW_STATE_DIR: sharedEnv.stateDir,
    OPENCLAW_CONFIG_PATH: sharedEnv.configPath,
  };
}

function resolveSharedServiceEnvironmentFields(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): SharedServiceEnvironmentFields {
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
  const nodeUseSystemCa = env.NODE_USE_SYSTEM_CA ?? (platform === "darwin" ? "1" : undefined);
  return {
    stateDir,
    configPath,
    tmpDir,
    minimalPath: buildMinimalServicePath({ env, requireExistingUserDirs: true }),
    proxyEnv,
    nodeCaCerts,
    nodeUseSystemCa,
  };
}
