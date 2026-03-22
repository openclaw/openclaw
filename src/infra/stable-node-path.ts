import fs from "node:fs/promises";
import path from "node:path";

/**
 * Homebrew Cellar paths (e.g. /opt/homebrew/Cellar/node/25.7.0/bin/node)
 * break when Homebrew upgrades Node and removes the old version directory.
 * Resolve these to a stable Homebrew-managed path that survives upgrades:
 *   - Default formula "node":  <prefix>/opt/node/bin/node  or  <prefix>/bin/node
 *   - Versioned formula "node@22":  <prefix>/opt/node@22/bin/node  (keg-only)
 *
 * Volta tools/image paths (e.g. ~/.volta/tools/image/node/24.14.0/bin/node)
 * become stale when Volta pins a different version. Resolve these to the
 * stable Volta shim at ~/.volta/bin/node which always delegates to the
 * currently-pinned version.
 */
export async function resolveStableNodePath(nodePath: string): Promise<string> {
  // Volta: ~/.volta/tools/image/node/<version>/bin/node[.exe]
  const voltaImageMatch = nodePath.match(
    /^(.+?)[/\\]\.volta[/\\]tools[/\\]image[/\\]node[/\\][^/\\]+[/\\]bin[/\\]node(?:\.exe)?$/,
  );
  if (voltaImageMatch) {
    const home = voltaImageMatch[1];
    const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;
    const ext = nodePath.endsWith(".exe") ? ".exe" : "";
    const shimPath = pathModule.join(home, ".volta", "bin", `node${ext}`);
    try {
      await fs.access(shimPath);
      return shimPath;
    } catch {
      // Volta shim not accessible; fall through and return original path.
    }
  }

  const cellarMatch = nodePath.match(
    /^(.+?)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/,
  );
  if (!cellarMatch) {
    return nodePath;
  }
  const prefix = cellarMatch[1]; // e.g. /opt/homebrew
  const formula = cellarMatch[2]; // e.g. "node" or "node@22"
  const pathModule = nodePath.includes("\\") ? path.win32 : path.posix;

  // Try the Homebrew opt symlink first — works for both default and versioned formulas.
  const optPath = pathModule.join(prefix, "opt", formula, "bin", "node");
  try {
    await fs.access(optPath);
    return optPath;
  } catch {
    // fall through
  }

  // For the default "node" formula, also try the direct bin symlink.
  if (formula === "node") {
    const binPath = pathModule.join(prefix, "bin", "node");
    try {
      await fs.access(binPath);
      return binPath;
    } catch {
      // fall through
    }
  }

  return nodePath;
}
