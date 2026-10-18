import path from "node:path";
import { pathExists } from "../utils.js";
import { applyNpmFreshnessBypassEnv, applyPosixNpmScriptShellEnv } from "./npm-install-env.js";
import { applyPathPrepend } from "./path-prepend.js";
import { resolvePnpmHome } from "./update-native-package-owner.js";

async function resolvePortableGitPathPrepend(): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return [];
  }
  const portableGitRoot = path.join(localAppData, "OpenClaw", "deps", "portable-git");
  const candidates = [
    path.join(portableGitRoot, "mingw64", "bin"),
    path.join(portableGitRoot, "usr", "bin"),
    path.join(portableGitRoot, "cmd"),
    path.join(portableGitRoot, "bin"),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

export type GlobalInstallManager = "npm" | "pnpm" | "bun";

/** Prepares the selected package manager for unattended global installs. */
export async function createGlobalInstallEnv(
  env?: NodeJS.ProcessEnv,
  options: { manager?: GlobalInstallManager; globalRoot?: string | null } = {},
): Promise<NodeJS.ProcessEnv> {
  const pathPrepend = await resolvePortableGitPathPrepend();
  const sourceEnv = env ?? process.env;
  const merged: Record<string, string> = Object.fromEntries(
    Object.entries(sourceEnv)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  );
  applyPathPrepend(merged, pathPrepend);
  const pnpmHome = options.manager === "pnpm" ? resolvePnpmHome(options.globalRoot) : null;
  if (pnpmHome) {
    merged.PNPM_HOME = pnpmHome;
    applyPathPrepend(merged, [path.join(pnpmHome, "bin")]);
  }
  if (process.platform === "win32") {
    merged.NPM_CONFIG_UPDATE_NOTIFIER = "false";
    merged.NPM_CONFIG_FUND = "false";
    merged.NPM_CONFIG_AUDIT = "false";
  }
  if (!merged.COREPACK_ENABLE_DOWNLOAD_PROMPT?.trim()) {
    merged.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
  }
  // Npm freshness policy probes npm itself; Bun installs neither need nor may spawn it.
  if (options.manager !== "bun") {
    applyNpmFreshnessBypassEnv(merged);
  }
  applyPosixNpmScriptShellEnv(merged);
  // Candidate lifecycle uses this pin for Bun-only global launchers, including private staging.
  if (process.versions.bun) {
    merged.OPENCLAW_PACKAGE_BUN_LAUNCHER = process.execPath;
  }
  return merged;
}
