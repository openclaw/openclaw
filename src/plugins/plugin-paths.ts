import path from "node:path";
import { resolveUserPath } from "../utils.js";

/**
 * Resolve paths exposed through the plugin API. Empty, absolute, and home-relative
 * inputs keep the historical user-path behavior; ordinary relative paths are
 * rooted at the plugin install/source directory.
 */
export function resolvePluginPath(input: string, rootDir: string | undefined): string {
  const trimmed = input?.trim() ?? "";
  if (!trimmed) return resolveUserPath(input);
  if (path.isAbsolute(trimmed) || trimmed.startsWith("~")) return resolveUserPath(input);
  return rootDir ? path.resolve(rootDir, trimmed) : resolveUserPath(input);
}
