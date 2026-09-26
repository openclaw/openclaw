import path from "node:path";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";

/**
 * Resolves pnpm's global-dir from its active global package root.
 * pnpm 10 used `<globalDir>/<version>/node_modules`; pnpm 11 uses
 * `<globalDir>/v<version>` with isolated package projects below it.
 */
export function resolvePnpmGlobalDirFromGlobalRoot(globalRoot?: string | null): string | null {
  const trimmed = globalRoot?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.resolve(trimmed);
  if (/^v\d+$/u.test(path.basename(normalized))) {
    return path.dirname(normalized);
  }
  if (path.basename(normalized) !== "node_modules") {
    return null;
  }
  const layoutDir = path.dirname(normalized);
  return /^\d+$/u.test(path.basename(layoutDir)) ? path.dirname(layoutDir) : null;
}

/** Native activation replaces the complete manager project, not only its package directory. */
export function resolveNativePackageProjectRoot(
  target: {
    manager: "npm" | "pnpm" | "bun";
    globalRoot: string | null;
    packageRoot: string | null;
  },
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return target.manager === "pnpm"
    ? resolvePnpmGlobalDirFromGlobalRoot(target.globalRoot)
    : target.manager === "bun"
      ? (resolveBunGlobalInstallOwner(target.packageRoot, env)?.globalProjectRoot ?? null)
      : null;
}
