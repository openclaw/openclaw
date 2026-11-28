import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { stableHomebrewNodePathCandidates } from "@openclaw/normalization-core/stable-node-path";
import { pathExists } from "./fs-safe.js";

/**
 * Version-manager shells expose a per-shell link to the running Node, such as
 * fnm's `<localappdata>/fnm_multishells/<pid>_<stamp>/node.exe`. The link exists
 * while the installing shell lives and disappears when it exits, so a service
 * recorded with that path fails to launch afterwards. Resolve the link to the
 * installation it points at, which is what survives the shell.
 */
async function canonicalNodePath(nodePath: string): Promise<string> {
  try {
    return await fs.realpath(nodePath);
  } catch {
    return nodePath;
  }
}

/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 */
export async function resolveStableNodePath(nodePath: string): Promise<string> {
  const canonicalPath = await canonicalNodePath(nodePath);
  for (const candidate of stableHomebrewNodePathCandidates(canonicalPath)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return canonicalPath;
}

// Keep the running Node version until Homebrew removes its Cellar keg.
export function resolveLaunchableNodePath(nodePath = process.execPath): string {
  if (existsSync(nodePath)) {
    return nodePath;
  }
  return stableHomebrewNodePathCandidates(nodePath).find(existsSync) ?? nodePath;
}
