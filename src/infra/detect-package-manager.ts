// Detects the package manager used by a project directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

/**
 * Lock files that serve as ground-truth evidence of the package manager
 * actually used to install the package.  npm global installs ship
 * `npm-shrinkwrap.json` rather than `package-lock.json`, so both must be
 * recognised.
 */
const LOCK_FILE_MANAGERS: Array<{ files: readonly string[]; manager: DetectedPackageManager }> = [
  { files: ["pnpm-lock.yaml"], manager: "pnpm" },
  { files: ["bun.lock", "bun.lockb"], manager: "bun" },
  { files: ["package-lock.json", "npm-shrinkwrap.json"], manager: "npm" },
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function resolveBunGlobalNodeModules(): string {
  return path.join(
    process.env.BUN_INSTALL || path.join(os.homedir(), ".bun"),
    "install",
    "global",
    "node_modules",
  );
}

function resolvePnpmNodeModulesRoot(root: string): string | null {
  const resolved = path.resolve(root);
  const parts = resolved.split(path.sep);
  const pnpmIndex = parts.lastIndexOf(".pnpm");
  if (pnpmIndex > 0) {
    const layoutRoot = parts.slice(0, pnpmIndex).join(path.sep) || path.sep;
    return path.basename(layoutRoot) === "node_modules"
      ? layoutRoot
      : path.join(layoutRoot, "node_modules");
  }

  const parent = path.dirname(resolved);
  return path.basename(parent) === "node_modules" ? parent : null;
}

async function isBunOwnedPackageRoot(root: string): Promise<boolean> {
  return path.resolve(path.dirname(root)) === path.resolve(resolveBunGlobalNodeModules());
}

async function isPnpmOwnedPackageRoot(root: string): Promise<boolean> {
  const nodeModulesRoot = resolvePnpmNodeModulesRoot(root);
  if (!nodeModulesRoot || !(await exists(path.join(nodeModulesRoot, ".modules.yaml")))) {
    return false;
  }
  return true;
}

/** Detects the package manager that owns a package root from manifests, locks, and install layout. */
export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  // 1. Lock files are the ground truth — they prove what package manager
  //    was actually used to install.  Check them first so that an npm
  //    global install of a pnpm-authored package (whose package.json
  //    carries "packageManager": "pnpm") still reports "npm".
  const entries = await fs.readdir(root).catch((): string[] => []);
  for (const { files, manager } of LOCK_FILE_MANAGERS) {
    if (files.some((f) => entries.includes(f))) {
      return manager;
    }
  }

  // 2. No lock file — fall back to the package.json declaration.
  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  const files = await fs.readdir(root).catch((): string[] => []);
  const hasNpmShrinkwrap = files.includes("npm-shrinkwrap.json");
  const hasPnpmLock = files.includes("pnpm-lock.yaml");
  const hasBunLock = files.includes("bun.lock") || files.includes("bun.lockb");

  if (hasNpmShrinkwrap) {
    // Published npm packages carry npm-shrinkwrap even when their source uses pnpm;
    // installed pnpm/bun-owned roots need layout proof before overriding npm.
    if (await isBunOwnedPackageRoot(root)) {
      return "bun";
    }
    if (pm === "pnpm" && (hasPnpmLock || (await isPnpmOwnedPackageRoot(root)))) {
      return "pnpm";
    }
    if (pm === "bun" && hasBunLock) {
      return "bun";
    }
    return "npm";
  }

  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

  if (hasPnpmLock) {
    return "pnpm";
  }
  if (hasBunLock) {
    return "bun";
  }
  if (files.includes("package-lock.json") || hasNpmShrinkwrap) {
    return "npm";
  }
  return null;
}
