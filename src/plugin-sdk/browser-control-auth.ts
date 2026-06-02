import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

export type BrowserControlAuth = {
  /** Bearer-style token used by browser control clients. */
  token?: string;
  /** Optional password used by legacy/basic browser control clients. */
  password?: string;
};

type EnsureBrowserControlAuthParams = {
  /** Resolved config that may receive or already contain generated auth. */
  cfg: OpenClawConfig;
  /** Environment override used by tests and nonstandard runtime hosts. */
  env?: NodeJS.ProcessEnv;
};

type EnsureBrowserControlAuthResult = {
  /** Effective auth after reading config/env and optional generation. */
  auth: BrowserControlAuth;
  /** Newly generated token persisted during this call, when generation was needed. */
  generatedToken?: string;
};

type BrowserControlAuthSurface = {
  resolveBrowserControlAuth: (cfg?: OpenClawConfig, env?: NodeJS.ProcessEnv) => BrowserControlAuth;
  shouldAutoGenerateBrowserAuth: (env: NodeJS.ProcessEnv) => boolean;
  ensureBrowserControlAuth: (
    params: EnsureBrowserControlAuthParams,
  ) => Promise<EnsureBrowserControlAuthResult>;
};

let cachedBrowserControlAuthSurface: BrowserControlAuthSurface | undefined;

function loadBrowserControlAuthSurface(): BrowserControlAuthSurface {
  cachedBrowserControlAuthSurface ??=
    loadBundledPluginPublicSurfaceModuleSync<BrowserControlAuthSurface>({
      dirName: "browser",
      artifactBasename: "browser-control-auth.js",
    });
  return cachedBrowserControlAuthSurface;
}

export function resolveBrowserControlAuth(
  cfg?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BrowserControlAuth {
  return loadBrowserControlAuthSurface().resolveBrowserControlAuth(cfg, env);
}

/** Returns whether this process should create browser-control auth when config lacks it. */
export function shouldAutoGenerateBrowserAuth(env: NodeJS.ProcessEnv): boolean {
  return loadBrowserControlAuthSurface().shouldAutoGenerateBrowserAuth(env);
}

/** Ensures browser-control auth exists, generating/persisting a token when policy allows. */
export async function ensureBrowserControlAuth(
  params: EnsureBrowserControlAuthParams,
): Promise<EnsureBrowserControlAuthResult> {
  return await loadBrowserControlAuthSurface().ensureBrowserControlAuth(params);
}
