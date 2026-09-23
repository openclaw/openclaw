/** Formats plugin source paths for user-facing status output. */
import path from "node:path";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { isPathInside } from "../infra/path-guards.js";
import { shortenHomePath } from "../utils.js";
import type { PluginRecord } from "./registry.js";
import type { PluginSourceRoots } from "./roots.js";
export { resolvePluginSourceRoots } from "./roots.js";

// Table cells wrap instead of truncating, so an unbounded absolute path can
// stretch one plugin row across 5+ terminal lines. Verbose/JSON output keeps
// the full pasteable path.
const TABLE_SOURCE_MAX_CHARS = 48;

function middleTruncatePath(value: string): string {
  if (value.length <= TABLE_SOURCE_MAX_CHARS) {
    return value;
  }
  const half = Math.floor((TABLE_SOURCE_MAX_CHARS - 3) / 2);
  return `${sliceUtf16Safe(value, 0, half)}...${sliceUtf16Safe(value, -half)}`;
}

function tryRelative(root: string, filePath: string): string | null {
  if (!isPathInside(root, filePath)) {
    return null;
  }
  const rel = path.relative(root, filePath);
  if (!rel || rel === ".") {
    return null;
  }
  // Normalize to forward slashes for display (path.relative uses backslashes on Windows)
  return rel.replaceAll("\\", "/");
}

/** Formats a plugin source path for status tables using known source roots. */
export function formatPluginSourceForTable(
  plugin: Pick<PluginRecord, "source" | "origin">,
  roots: PluginSourceRoots,
): { value: string; rootKey?: keyof PluginSourceRoots } {
  const raw = plugin.source;

  const rootKey = plugin.origin === "bundled" ? "stock" : plugin.origin;
  if (rootKey !== "config") {
    const root = roots[rootKey];
    const rel = root ? tryRelative(root, raw) : null;
    if (rel) {
      return { value: `${rootKey}:${rel}`, rootKey };
    }
  }

  return { value: middleTruncatePath(shortenHomePath(raw)) };
}
