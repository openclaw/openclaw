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

function resolveSystemPathDirs(platform: NodeJS.Platform): string[] {
  if (platform === "linux") {
    return ["/usr/local/bin", "/usr/bin", "/bin"];
  }
  return [];
}

/**
 * Resolve common user bin directories for Linux/WSL.
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
  addNonEmptyDir(dirs, env?.PNPM_HOME);
  addNonEmptyDir(dirs, appendSubdir(env?.NPM_CONFIG_PREFIX, "bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.BUN_INSTALL, "bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.VOLTA_HOME, "bin"));
  addNonEmptyDir(dirs, appendSubdir(env?.ASDF_DATA_DIR, "shims"));
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
  const userDirs = platform === "linux" ? resolveLinuxUserBinDirs(options.home, options.env) : [];

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
}): Record<string, string | undefined> {
  const { env, port, token, launchdLabel } = params;
  const profile = env.OPENCLAW_PROFILE;
  const resolvedLaunchdLabel = launchdLabel ?? undefined;
  const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  return {
    HOME: env.HOME,
    PATH: buildMinimalServicePath({ env }),
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
}): Record<string, string | undefined> {
  const { env } = params;
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  return {
    HOME: env.HOME,
    PATH: buildMinimalServicePath({ env }),
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
