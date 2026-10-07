import { existsSync } from "node:fs";
import { pathExists } from "@openclaw/fs-safe/advanced";
import { stableHomebrewNodePathCandidates } from "@openclaw/normalization-core/stable-node-path";

/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 */
export async function resolveStableNodePath(nodePath: string): Promise<string> {
  for (const candidate of stableHomebrewNodePathCandidates(nodePath)) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return nodePath;
}

/** For independent children only; native/V8 workers must keep the parent's exact runtime. */
export function resolveChildNodePath(): string {
  const nodePath = process.execPath;
  const candidates = stableHomebrewNodePathCandidates(nodePath);
  if (candidates.length === 0 || existsSync(nodePath)) {
    return nodePath;
  }
  // Stay synchronous so launch authority and cleanup custody cannot change during resolution.
  return candidates.find((candidate) => existsSync(candidate)) ?? nodePath;
}
