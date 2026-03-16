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

  try {
    const packageRoots = [
      resolveOpenClawPackageRootSync({ cwd: process.cwd() }),
      resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url }),
    ].filter(
      (entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index,
    );
    for (const packageRoot of packageRoots) {
      // Local source checkouts stage a runtime-complete bundled plugin tree under
      // dist-runtime/. Prefer that over release-shaped dist/extensions.
      const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
      if (fs.existsSync(runtimeExtensionsDir)) {
        return runtimeExtensionsDir;
      }
    }
  } catch {
    // ignore
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
