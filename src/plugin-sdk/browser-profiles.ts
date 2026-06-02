import path from "node:path";
import type { BrowserConfig, BrowserProfileConfig, OpenClawConfig } from "../config/config.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export const DEFAULT_OPENCLAW_BROWSER_ENABLED = true;
export const DEFAULT_BROWSER_EVALUATE_ENABLED = true;
/** Default marker color used for OpenClaw-owned browser sessions. */
export const DEFAULT_OPENCLAW_BROWSER_COLOR = "#FF4500";
/** Built-in profile name used when config does not select a browser profile. */
export const DEFAULT_OPENCLAW_BROWSER_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_DEFAULT_PROFILE_NAME = "openclaw";
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 60_000;
export const DEFAULT_AI_SNAPSHOT_MAX_CHARS = 80_000;
export const DEFAULT_UPLOAD_DIR = path.join(resolvePreferredOpenClawTmpDir(), "uploads");

/** Browser tab cleanup policy after config defaults have been applied. */
export type ResolvedBrowserTabCleanupConfig = {
  enabled: boolean;
  idleMinutes: number;
  maxTabsPerSession: number;
  sweepMinutes: number;
};

/** Fully resolved browser runtime config exposed through the SDK facade. */
export type ResolvedBrowserConfig = {
  enabled: boolean;
  evaluateEnabled: boolean;
  controlPort: number;
  cdpPortRangeStart: number;
  cdpPortRangeEnd: number;
  cdpProtocol: "http" | "https";
  cdpHost: string;
  cdpIsLoopback: boolean;
  remoteCdpTimeoutMs: number;
  remoteCdpHandshakeTimeoutMs: number;
  localLaunchTimeoutMs: number;
  localCdpReadyTimeoutMs: number;
  actionTimeoutMs: number;
  color: string;
  executablePath?: string;
  headless: boolean;
  noSandbox: boolean;
  attachOnly: boolean;
  defaultProfile: string;
  profiles: Record<string, BrowserProfileConfig>;
  tabCleanup: ResolvedBrowserTabCleanupConfig;
  ssrfPolicy?: SsrFPolicy;
  extraArgs: string[];
};

/** Concrete browser profile connection target selected for a runtime session. */
export type ResolvedBrowserProfile = {
  name: string;
  cdpPort: number;
  cdpUrl: string;
  cdpHost: string;
  cdpIsLoopback: boolean;
  userDataDir?: string;
  color: string;
  driver: "openclaw" | "existing-session";
  headless?: boolean;
  attachOnly: boolean;
};

type BrowserProfilesSurface = {
  resolveBrowserConfig: (
    cfg: BrowserConfig | undefined,
    rootConfig?: OpenClawConfig,
  ) => ResolvedBrowserConfig;
  resolveProfile: (
    resolved: ResolvedBrowserConfig,
    profileName: string,
  ) => ResolvedBrowserProfile | null;
};

let cachedBrowserProfilesSurface: BrowserProfilesSurface | undefined;

/** Load once so SDK callers share the bundled browser profile facade instance. */
function loadBrowserProfilesSurface(): BrowserProfilesSurface {
  cachedBrowserProfilesSurface ??= loadBundledPluginPublicSurfaceModuleSync<BrowserProfilesSurface>(
    {
      dirName: "browser",
      artifactBasename: "browser-profiles.js",
    },
  );
  return cachedBrowserProfilesSurface;
}

/** Resolve raw browser config into the normalized runtime shape used by browser tools. */
export function resolveBrowserConfig(
  cfg: BrowserConfig | undefined,
  rootConfig?: OpenClawConfig,
): ResolvedBrowserConfig {
  return loadBrowserProfilesSurface().resolveBrowserConfig(cfg, rootConfig);
}

/** Select a named profile from resolved browser config, or null when it is unavailable. */
export function resolveProfile(
  resolved: ResolvedBrowserConfig,
  profileName: string,
): ResolvedBrowserProfile | null {
  return loadBrowserProfilesSurface().resolveProfile(resolved, profileName);
}
