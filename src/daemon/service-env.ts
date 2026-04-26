import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isNodeVersionManagerRuntime,
  resolveLinuxSystemCaBundle,
} from "../bootstrap/node-extra-ca-certs.js";
import { resolveNodeStartupTlsEnvironment } from "../bootstrap/node-startup-env.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { VERSION } from "../version.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
  NODE_SERVICE_KIND,
  NODE_SERVICE_MARKER,
  NODE_WINDOWS_TASK_SCRIPT_NAME,
  resolveNodeLaunchAgentLabel,
  resolveNodeSystemdServiceName,
  resolveNodeWindowsTaskName,
} from "./constants.js";

export { isNodeVersionManagerRuntime, resolveLinuxSystemCaBundle };

export type MinimalServicePathOptions = {
  platform?: NodeJS.Platform;
  extraDirs?: string[];
  home?: string;
  env?: Record<string, string | undefined>;
  /**
   * Predicate used to check whether an optional version-manager directory exists
   * on disk. Injected for tests; defaults to {@link fs.existsSync}. Only consulted
   * for hard-coded version-manager fallbacks (volta, asdf, bun, fnm, pnpm); env-driven
   * roots (PNPM_HOME, VOLTA_HOME, …) and stable user dirs (~/.local/bin, ~/.npm-global/bin,
   * ~/bin) remain unconditional.
   */
  existsSync?: (candidate: string) => boolean;
};

type BuildServicePathOptions = MinimalServicePathOptions & {
  env?: Record<string, string | undefined>;
};

type SharedServiceEnvironmentFields = {
  stateDir: string | undefined;
  configPath: string | undefined;
  tmpDir: string;
  minimalPath: string | undefined;
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

function addCommonUserBinDirs(
  dirs: string[],
  home: string,
  existsSync: (candidate: string) => boolean,
): void {
  // Stable user-bin conventions — emit unconditionally. The audit excludes these.
  dirs.push(`${home}/.local/bin`);
  dirs.push(`${home}/.npm-global/bin`);
  dirs.push(`${home}/bin`);
  // Version-manager fallbacks — only emit when the directory actually exists.
  // Otherwise the gateway plist contains paths that never resolve and the
  // service-audit (gateway.path.non-minimal) flags its own writes.
  addExistingDir(dirs, `${home}/.volta/bin`, existsSync);
  addExistingDir(dirs, `${home}/.asdf/shims`, existsSync);
  addExistingDir(dirs, `${home}/.bun/bin`, existsSync);
}

function addExistingDir(
  dirs: string[],
  candidate: string,
  existsSync: (candidate: string) => boolean,
): void {
  if (existsSync(candidate)) {
    dirs.push(candidate);
  }
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

// Nix shell precedence: rightmost profile in NIX_PROFILES = highest priority.
// When NIX_PROFILES is absent, fall back to the default single-user profile.
function addNixProfileBinDirs(
  dirs: string[],
  home: string,
  env: Record<string, string | undefined> | undefined,
): void {
  const nixProfiles = env?.NIX_PROFILES?.trim();
  if (nixProfiles) {
    for (const profile of nixProfiles.split(/\s+/).toReversed()) {
      addNonEmptyDir(dirs, appendSubdir(profile, "bin"));
    }
  } else {
    dirs.push(`${home}/.nix-profile/bin`);
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
  existsSync: (candidate: string) => boolean = fs.existsSync,
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
  addCommonUserBinDirs(dirs, home, existsSync);

  // Nix Home Manager (cross-platform)
  addNixProfileBinDirs(dirs, home, env);

  // Node version managers - macOS specific paths.
  // Only emit hard-coded fallbacks that actually exist on disk so the gateway
  // plist matches what the doctor's gateway.path.non-minimal audit will accept.
  // Env-driven equivalents (FNM_DIR, PNPM_HOME) above stay unconditional.
  addExistingDir(dirs, `${home}/Library/Application Support/fnm/aliases/default/bin`, existsSync); // fnm default
  addExistingDir(dirs, `${home}/.fnm/aliases/default/bin`, existsSync); // fnm if customized to ~/.fnm
  addExistingDir(dirs, `${home}/Library/pnpm`, existsSync); // pnpm default on macOS
  addExistingDir(dirs, `${home}/.local/share/pnpm`, existsSync); // pnpm XDG fallback

  return dirs;
}

/**
 * Resolve common user bin directories for Linux.
 * These are paths where npm global installs and node version managers typically place binaries.
 */
export function resolveLinuxUserBinDirs(
  home: string | undefined,
  env?: Record<string, string | undefined>,
  existsSync: (candidate: string) => boolean = fs.existsSync,
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
  addCommonUserBinDirs(dirs, home, existsSync);

  // Nix Home Manager (cross-platform)
  addNixProfileBinDirs(dirs, home, env);

  // Node version managers - only emit when the directory actually exists.
  // Mirrors the macOS branch so the gateway plist agrees with the audit.
  addExistingDir(dirs, `${home}/.nvm/current/bin`, existsSync); // nvm with current symlink
  addExistingDir(dirs, `${home}/.fnm/current/bin`, existsSync); // fnm
  addExistingDir(dirs, `${home}/.local/share/pnpm`, existsSync); // pnpm global bin

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

  // Add user bin directories for version managers (npm global, nvm, fnm, volta, etc.).
  // Hard-coded VM fallbacks are filtered through `existsSync` so the plist matches
  // what `service-audit.ts:gateway.path.non-minimal` will accept.
  const existsSync = options.existsSync ?? fs.existsSync;
  const userDirs =
    platform === "linux"
      ? resolveLinuxUserBinDirs(options.home, options.env, existsSync)
      : platform === "darwin"
        ? resolveDarwinUserBinDirs(options.home, options.env, existsSync)
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
  launchdLabel?: string;
  platform?: NodeJS.Platform;
  extraPathDirs?: string[];
  execPath?: string;
}): Record<string, string | undefined> {
  const { env, port, launchdLabel, extraPathDirs } = params;
  const platform = params.platform ?? process.platform;
  const sharedEnv = resolveSharedServiceEnvironmentFields(
    env,
    platform,
    extraPathDirs,
    params.execPath,
  );
  const profile = env.OPENCLAW_PROFILE;
  const resolvedLaunchdLabel =
    launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : undefined);
  const systemdUnit = `${resolveGatewaySystemdServiceName(profile)}.service`;
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_PROFILE: profile,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
    OPENCLAW_SYSTEMD_UNIT: systemdUnit,
    OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
    OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
    OPENCLAW_SERVICE_VERSION: VERSION,
  };
}

export function buildNodeServiceEnvironment(params: {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  extraPathDirs?: string[];
  execPath?: string;
}): Record<string, string | undefined> {
  const { env, extraPathDirs } = params;
  const platform = params.platform ?? process.platform;
  const sharedEnv = resolveSharedServiceEnvironmentFields(
    env,
    platform,
    extraPathDirs,
    params.execPath,
  );
  const gatewayToken = normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN);
  const allowInsecurePrivateWs = normalizeOptionalString(env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS);
  return {
    ...buildCommonServiceEnvironment(env, sharedEnv),
    OPENCLAW_GATEWAY_TOKEN: gatewayToken,
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: allowInsecurePrivateWs,
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
  const serviceEnv: Record<string, string | undefined> = {
    HOME: env.HOME,
    TMPDIR: sharedEnv.tmpDir,
    ...sharedEnv.proxyEnv,
    NODE_EXTRA_CA_CERTS: sharedEnv.nodeCaCerts,
    NODE_USE_SYSTEM_CA: sharedEnv.nodeUseSystemCa,
    OPENCLAW_STATE_DIR: sharedEnv.stateDir,
    OPENCLAW_CONFIG_PATH: sharedEnv.configPath,
  };
  if (sharedEnv.minimalPath) {
    serviceEnv.PATH = sharedEnv.minimalPath;
  }
  return serviceEnv;
}

function resolveSharedServiceEnvironmentFields(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  extraPathDirs: string[] | undefined,
  execPath?: string,
): SharedServiceEnvironmentFields {
  const stateDir = env.OPENCLAW_STATE_DIR;
  const configPath = env.OPENCLAW_CONFIG_PATH;
  // Keep a usable temp directory for supervised services even when the host env omits TMPDIR.
  const tmpDir = env.TMPDIR?.trim() || os.tmpdir();
  const proxyEnv = readServiceProxyEnvironment(env);
  // On macOS, launchd services don't inherit the shell environment, so Node's undici/fetch
  // cannot locate the system CA bundle. Default to /etc/ssl/cert.pem so TLS verification
  // works correctly when running as a LaunchAgent without extra user configuration.
  // On Linux, nvm-installed Node may need the host CA bundle injected before startup.
  const startupTlsEnv = resolveNodeStartupTlsEnvironment({
    env,
    platform,
    execPath,
  });
  return {
    stateDir,
    configPath,
    tmpDir,
    // On Windows, Scheduled Tasks should inherit the current task PATH instead of
    // freezing the install-time snapshot into gateway.cmd/node-host.cmd.
    minimalPath:
      platform === "win32"
        ? undefined
        : buildMinimalServicePath({ env, platform, extraDirs: extraPathDirs }),
    proxyEnv,
    nodeCaCerts: startupTlsEnv.NODE_EXTRA_CA_CERTS,
    nodeUseSystemCa: startupTlsEnv.NODE_USE_SYSTEM_CA,
  };
}
