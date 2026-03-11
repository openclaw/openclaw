import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

const HOOK_HANDLER_CANDIDATES = ["handler.js", "handler.ts", "index.js", "index.ts"];

function isSameOrDescendantPath(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isDirectoryLike(entry: fs.Dirent, fullPath: string): boolean {
  if (entry.isDirectory()) {
    return true;
  }
  if (!entry.isSymbolicLink()) {
    return false;
  }
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeBundledHooksDir(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const hookDir = path.join(dir, entry.name);
      if (!isDirectoryLike(entry, hookDir)) {
        continue;
      }
      if (!fs.existsSync(path.join(hookDir, "HOOK.md"))) {
        continue;
      }
      if (
        HOOK_HANDLER_CANDIDATES.some((candidate) => fs.existsSync(path.join(hookDir, candidate)))
      ) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

export type BundledHooksResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

export function resolveBundledHooksDir(opts: BundledHooksResolveOptions = {}): string | undefined {
  const override = process.env.OPENCLAW_BUNDLED_HOOKS_DIR?.trim();
  if (override) {
    return override;
  }

  // bun --compile: ship a sibling `hooks/bundled/` next to the executable.
  try {
    const execPath = opts.execPath ?? process.execPath;
    const execDir = path.dirname(execPath);
    const sibling = path.join(execDir, "hooks", "bundled");
    if (looksLikeBundledHooksDir(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: prefer package-root relative lookup so pnpm/global symlink layouts resolve reliably.
  try {
    const moduleUrl = opts.moduleUrl ?? import.meta.url;
    const moduleDir = path.resolve(path.dirname(fileURLToPath(moduleUrl)));
    const argv1 = opts.argv1 ?? process.argv[1];
    const cwd = opts.cwd ?? process.cwd();
    const packageRoot = resolveOpenClawPackageRootSync({
      argv1,
      moduleUrl,
      cwd,
    });
    const normalizedPackageRoot = packageRoot ? path.resolve(packageRoot) : null;
    if (packageRoot) {
      const distBundled = path.join(packageRoot, "dist", "bundled");
      if (looksLikeBundledHooksDir(distBundled)) {
        return distBundled;
      }
      const srcBundled = path.join(packageRoot, "src", "hooks", "bundled");
      if (looksLikeBundledHooksDir(srcBundled)) {
        return srcBundled;
      }
    }

    // Fallback: walk up from the module location for layouts where package-root discovery fails.
    let current =
      normalizedPackageRoot && !isSameOrDescendantPath(moduleDir, normalizedPackageRoot)
        ? normalizedPackageRoot
        : moduleDir;
    for (let depth = 0; depth < 6; depth += 1) {
      if (normalizedPackageRoot && !isSameOrDescendantPath(current, normalizedPackageRoot)) {
        break;
      }
      const candidate = path.join(current, "bundled");
      if (looksLikeBundledHooksDir(candidate)) {
        return candidate;
      }
      const parent = path.dirname(current);
      if (
        parent === current ||
        (normalizedPackageRoot && !isSameOrDescendantPath(parent, normalizedPackageRoot))
      ) {
        break;
      }
      current = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
