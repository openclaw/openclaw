import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolveBundledPluginsDir(): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `extensions/` next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const sibling = path.join(execDir, "extensions");
    if (fs.existsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find `extensions/` at the package root.
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}

/**
 * Resolve the on-disk directory for a bundled extension by plugin id.
 * Returns undefined if the extension is not found in the bundled plugins dir.
 */
export function resolveBundledExtensionDir(pluginId: string): string | undefined {
  const root = resolveBundledPluginsDir();
  if (!root) {
    return undefined;
  }
  const dir = path.join(root, pluginId);
  if (fs.existsSync(path.join(dir, "package.json"))) {
    return dir;
  }
  return undefined;
}
