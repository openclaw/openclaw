// Detects the package manager used by a project directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

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

function resolveDirectNodeModulesRoot(root: string): string | null {
  const parent = path.dirname(root);
  if (path.basename(parent) === "node_modules") {
    return parent;
  }

  const grandparent = path.dirname(parent);
  return path.basename(parent).startsWith("@") && path.basename(grandparent) === "node_modules"
    ? grandparent
    : null;
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

  return resolveDirectNodeModulesRoot(resolved);
}

async function isBunOwnedPackageRoot(root: string): Promise<boolean> {
  const nodeModulesRoot = resolveDirectNodeModulesRoot(path.resolve(root));
  return (
    nodeModulesRoot !== null &&
    path.resolve(nodeModulesRoot) === path.resolve(resolveBunGlobalNodeModules())
  );
}

async function isPnpmOwnedPackageRoot(root: string): Promise<boolean> {
  const nodeModulesRoot = resolvePnpmNodeModulesRoot(root);
  if (
    !nodeModulesRoot ||
    !(
      (await exists(path.join(nodeModulesRoot, ".modules.yaml"))) ||
      (await exists(path.join(nodeModulesRoot, ".pnpm"))) ||
      (await exists(path.join(nodeModulesRoot, ".pnpm-workspace-state-v1.json")))
    )
  ) {
    return false;
  }
  return true;
}

/** Detects the package manager that owns a package root from manifests, locks, and install layout. */
export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  const realRoot = await fs.realpath(root).catch(() => root);
  const packageManagerSpec =
    (await readPackageManagerSpec(root)) ??
    (path.resolve(realRoot) === path.resolve(root) ? null : await readPackageManagerSpec(realRoot));
  const pm = packageManagerSpec?.split("@")[0]?.trim();
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
