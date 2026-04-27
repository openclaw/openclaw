/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 */
export declare function resolveStableNodePath(nodePath: string): Promise<string>;
