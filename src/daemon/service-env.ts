import fs from "node:fs";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveNodeStartupTlsEnvironment } from "../bootstrap/node-startup-env.js";
import type { GatewayDaemonRuntime } from "../commands/daemon-runtime.js";
import { omitSecretEgressProxyEnvironment } from "../secrets/egress-proxy/environment.js";
import {
  GATEWAY_SERVICE_KIND,
  GATEWAY_SERVICE_MARKER,
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
  resolveNodeServiceIdentityEnvironment,
} from "./constants.js";
import { resolveGatewayHeapNodeOptions } from "./gateway-heap.js";
import { resolveServiceTmpDir } from "./service-tmp-dir.js";

export const SERVICE_PROXY_ENV_KEYS = [
  "OPENCLAW_PROXY_URL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
] as const;

function normalizeServicePathDir(dir: string | undefined): string | undefined {
  const trimmed = dir?.trim();
  // Service PATH snapshots are only emitted for macOS/Linux; keep POSIX semantics
  // even when tests or helper callers run on Windows.
  if (!trimmed || !path.posix.isAbsolute(trimmed)) {
    return undefined;
  }
  return path.posix.normalize(trimmed);
}

function realpathServicePathDir(dir: string): string | undefined {
  try {
    return path.posix.normalize(fs.realpathSync.native(dir));
  } catch {
    return undefined;
  }
}

function realpathExistingServicePathDir(dir: string): string | undefined {
  const parts: string[] = [];
  let current = dir;
  // Resolve the nearest existing ancestor so future-created bin dirs can still
  // be compared against the install workspace realpath.
  while (true) {
    const realCurrent = realpathServicePathDir(current);
    if (realCurrent) {
      return path.posix.join(realCurrent, ...parts.toReversed());
    }
    const parent = path.posix.dirname(current);
    if (!current || current === parent) {
      return undefined;
    }
    parts.push(path.posix.basename(current));
    current = parent;
  }
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isWorkspaceDerivedPath(dir: string, homeDir: string): boolean {
  // Install-time workspace env vars must not become durable service PATH entries.
  if (isSameOrChildPath(dir, "/proc")) {
    return true;
  }
  const cwd = normalizeServicePathDir(process.cwd());
  if (!cwd) {
    return false;
  }
  const home = normalizeServicePathDir(homeDir);
  if (home && cwd === home) {
    return false;
  }
  if (isSameOrChildPath(dir, cwd)) {
    return true;
  }
  const realDir = realpathExistingServicePathDir(dir);
  const realCwd = realpathServicePathDir(cwd);
  const realHome = home ? realpathServicePathDir(home) : undefined;
  return Boolean(realDir && realCwd && realHome !== realCwd && isSameOrChildPath(realDir, realCwd));
}

function addEnvConfiguredBinDir(dirs: string[], dir: string | undefined, home: string): void {
  const normalized = normalizeServicePathDir(dir);
  if (!normalized || isWorkspaceDerivedPath(normalized, home)) {
    return;
  }
  dirs.push(normalized);
}

function appendSubdir(base: string | undefined, subdir: string): string | undefined {
  if (!base) {
    return undefined;
  }
  return base.endsWith(`/${subdir}`) ? base : path.posix.join(base, subdir);
}

function addExistingDir(dirs: string[], candidate: string): void {
  if (fs.existsSync(candidate)) {
    dirs.push(candidate);
  }
}

function resolveSystemPathDirs(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];
  }
  if (platform === "linux") {
    return ["/usr/local/bin", "/usr/bin", "/bin"];
  }
  return [];
}

/** Resolve Linux user bin directories after trusted system directories. */
function resolveUserBinDirs(
  home: string | undefined,
  env: Record<string, string | undefined>,
  includeMissingUserBinDefaults = true,
): string[] {
  if (!home) {
    return [];
  }

  const dirs: string[] = [];
  addEnvConfiguredBinDir(dirs, env.PNPM_HOME, home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.PNPM_HOME, "bin"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.NPM_CONFIG_PREFIX, "bin"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.BUN_INSTALL, "bin"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.VOLTA_HOME, "bin"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.ASDF_DATA_DIR, "shims"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.NVM_DIR, "current/bin"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.FNM_DIR, "aliases/default/bin"), home);
  addEnvConfiguredBinDir(dirs, appendSubdir(env.FNM_DIR, "current/bin"), home);
  for (const directory of [".local/bin", ".npm-global/bin", "bin"]) {
    const candidate = `${home}/${directory}`;
    if (includeMissingUserBinDefaults || fs.existsSync(candidate)) {
      dirs.push(candidate);
    }
  }
  for (const directory of [".volta/bin", ".asdf/shims", ".bun/bin"]) {
    addExistingDir(dirs, `${home}/${directory}`);
  }
  // Nix gives the rightmost profile highest priority; otherwise use the default profile.
  const nixProfiles = env.NIX_PROFILES?.trim();
  if (nixProfiles) {
    for (const profile of nixProfiles.split(/\s+/).toReversed()) {
      addEnvConfiguredBinDir(dirs, appendSubdir(profile, "bin"), home);
    }
  } else {
    const defaultProfileBin = `${home}/.nix-profile/bin`;
    if (includeMissingUserBinDefaults || fs.existsSync(defaultProfileBin)) {
      dirs.push(defaultProfileBin);
    }
  }
  // Preserve both the pnpm root (v10) and its bin subdirectory (v11) in order.
  for (const directory of [
    ".nvm/current/bin",
    ".local/share/fnm/aliases/default/bin",
    ".local/share/fnm/current/bin",
    ".fnm/aliases/default/bin",
    ".fnm/current/bin",
    ".local/share/pnpm/bin",
    ".local/share/pnpm",
  ]) {
    addExistingDir(dirs, `${home}/${directory}`);
  }
  return dirs;
}

export function getMinimalServicePathPartsFromEnv(
  options: {
    platform?: NodeJS.Platform;
    extraDirs?: string[];
    home?: string;
    env?: Record<string, string | undefined>;
    includeMissingUserBinDefaults?: boolean;
  } = {},
): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    // Windows scheduled tasks inherit PATH from the task host; generated cmd
    // launchers should not freeze install-time PATH snapshots.
    return [];
  }

  const extraDirs = options.extraDirs ?? [];
  const systemDirs = resolveSystemPathDirs(platform);

  const userDirs =
    platform === "linux"
      ? resolveUserBinDirs(options.home ?? env.HOME, env, options.includeMissingUserBinDefaults)
      : [];

  return [...new Set([...extraDirs, ...systemDirs, ...userDirs].filter(Boolean))];
}

function resolveGatewaySystemdUnitEnv(env: Record<string, string | undefined>): string {
  const override = normalizeOptionalString(env.OPENCLAW_SYSTEMD_UNIT);
  if (override) {
    return override.endsWith(".service") ? override : `${override}.service`;
  }
  return `${resolveGatewaySystemdServiceName(env.OPENCLAW_PROFILE)}.service`;
}

type ServiceEnvironmentParams = {
  env: Record<string, string | undefined>;
  runtime?: GatewayDaemonRuntime;
  platform?: NodeJS.Platform;
  extraPathDirs?: string[];
  execPath?: string;
};

export function buildServiceEnvironment(
  params: ServiceEnvironmentParams & {
    port: number;
    existingNodeOptions?: string;
    launchdLabel?: string;
  },
): Record<string, string | undefined> {
  const { env, port, launchdLabel } = params;
  const platform = params.platform ?? process.platform;
  const commonEnvironment = buildCommonServiceEnvironment(params, platform);
  const profile = env.OPENCLAW_PROFILE;
  const wrapperPath = normalizeOptionalString(env.OPENCLAW_WRAPPER);
  const resolvedLaunchdLabel =
    launchdLabel || (platform === "darwin" ? resolveGatewayLaunchAgentLabel(profile) : undefined);
  const systemdUnit = resolveGatewaySystemdUnitEnv(env);
  return {
    ...commonEnvironment,
    // An empty assignment clears supervisor ambient options; omission would
    // allow preloads/debug flags to bypass the heap-only service boundary.
    NODE_OPTIONS: resolveGatewayHeapNodeOptions(
      params.existingNodeOptions,
      wrapperPath ? undefined : params.runtime,
    ),
    OPENCLAW_PROFILE: profile,
    ...(env.OPENCLAW_CONFIG_READONLY !== undefined
      ? { OPENCLAW_CONFIG_READONLY: env.OPENCLAW_CONFIG_READONLY }
      : {}),
    ...(env.OPENCLAW_CONFIG_READONLY_NOTICE !== undefined
      ? { OPENCLAW_CONFIG_READONLY_NOTICE: env.OPENCLAW_CONFIG_READONLY_NOTICE }
      : {}),
    OPENCLAW_WRAPPER: wrapperPath,
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_LAUNCHD_LABEL: resolvedLaunchdLabel,
    OPENCLAW_SYSTEMD_UNIT: systemdUnit,
    OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(profile),
    OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER: "1",
    OPENCLAW_SERVICE_MARKER: GATEWAY_SERVICE_MARKER,
    OPENCLAW_SERVICE_KIND: GATEWAY_SERVICE_KIND,
  };
}

export function buildNodeServiceEnvironment(
  params: ServiceEnvironmentParams,
): Record<string, string | undefined> {
  const { env } = params;
  const platform = params.platform ?? process.platform;
  const commonEnvironment = buildCommonServiceEnvironment(params, platform);
  return {
    ...commonEnvironment,
    OPENCLAW_GATEWAY_TOKEN: normalizeOptionalString(env.OPENCLAW_GATEWAY_TOKEN),
    OPENCLAW_GATEWAY_PASSWORD: normalizeOptionalString(env.OPENCLAW_GATEWAY_PASSWORD),
    CF_ACCESS_CLIENT_ID: normalizeOptionalString(env.CF_ACCESS_CLIENT_ID),
    CF_ACCESS_CLIENT_SECRET: normalizeOptionalString(env.CF_ACCESS_CLIENT_SECRET),
    OPENCLAW_ALLOW_INSECURE_PRIVATE_WS: normalizeOptionalString(
      env.OPENCLAW_ALLOW_INSECURE_PRIVATE_WS,
    ),
    // launchd manager variables outlive the installer. Worker snapshots scope
    // this host fence by the canonical managed-node service identity.
    NODE_DISABLE_COMPILE_CACHE: platform === "darwin" ? "1" : undefined,
    ...resolveNodeServiceIdentityEnvironment(env),
  };
}

function buildCommonServiceEnvironment(
  { env: invocationEnv, extraPathDirs, execPath, runtime }: ServiceEnvironmentParams,
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  const env = omitSecretEgressProxyEnvironment(invocationEnv, platform);
  const tmpDir = resolveServiceTmpDir(env, platform);
  // On macOS, launchd services don't inherit the shell environment, so default
  // NODE_USE_SYSTEM_CA to read the macOS trust store when running as a LaunchAgent.
  // On Linux, nvm-installed Node may need the host CA bundle injected before startup.
  const startupTlsEnv = resolveNodeStartupTlsEnvironment({
    env,
    platform,
    execPath,
  });
  // Windows tasks inherit PATH rather than freezing an install-time snapshot.
  const minimalPath =
    platform === "win32"
      ? undefined
      : getMinimalServicePathPartsFromEnv({ env, platform, extraDirs: extraPathDirs }).join(
          path.posix.delimiter,
        );
  // Generic shell proxy vars are audited but never frozen into services.
  const proxyUrl = normalizeOptionalString(env.OPENCLAW_PROXY_URL);
  const environment: Record<string, string | undefined> = {
    HOME: env.HOME,
    TMPDIR: tmpDir,
    NODE_EXTRA_CA_CERTS: startupTlsEnv.NODE_EXTRA_CA_CERTS,
    NODE_USE_SYSTEM_CA: startupTlsEnv.NODE_USE_SYSTEM_CA,
    OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
    OPENCLAW_CONFIG_PATH: env.OPENCLAW_CONFIG_PATH,
    ...(proxyUrl ? { OPENCLAW_PROXY_URL: proxyUrl } : {}),
    ...(minimalPath ? { PATH: minimalPath } : {}),
  };
  // Match the installing shell's probed SQLite library; wrappers hide the runtime.
  if (
    platform === "darwin" &&
    (runtime === "bun" || runtime === "standalone" || normalizeOptionalString(env.OPENCLAW_WRAPPER))
  ) {
    const library = normalizeOptionalString(env.OPENCLAW_SQLITE_LIBRARY);
    const prefix = normalizeOptionalString(env.HOMEBREW_PREFIX);
    if (library) {
      environment.OPENCLAW_SQLITE_LIBRARY = library;
    }
    if (prefix && path.posix.isAbsolute(prefix)) {
      environment.HOMEBREW_PREFIX = prefix;
    }
  }
  return environment;
}
