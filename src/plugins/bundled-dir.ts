import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveUserPath } from "../utils.js";

export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    return resolveUserPath(override, env);
  }

  if (env.OPENCLAW_WATCH_MODE === "1") {
    try {
      const packageRoot = resolveOpenClawPackageRootSync({ cwd: process.cwd() });
      if (packageRoot) {
        // In watch mode, prefer source plugin roots so plugin-local runtime deps
        // resolve from extensions/<id>/node_modules instead of stripped dist copies.
        const sourceExtensionsDir = path.join(packageRoot, "extensions");
        if (fs.existsSync(sourceExtensionsDir)) {
          return sourceExtensionsDir;
        }
      }
    } catch {
      // ignore
    }
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
