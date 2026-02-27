import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../utils.js";

export type OwnershipCheckResult = {
  ok: boolean;
  foreignFiles: string[];
  currentUid: number;
};

export type GlobalInstallManager = "npm" | "pnpm" | "bun";

export type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const PRIMARY_PACKAGE_NAME = "openclaw";
const ALL_PACKAGE_NAMES = [PRIMARY_PACKAGE_NAME] as const;
const GLOBAL_RENAME_PREFIX = ".";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = ["--no-fund", "--no-audit", "--loglevel=error"] as const;
const NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS = [
  "--omit=optional",
  ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
] as const;

async function tryRealpath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function resolveBunGlobalRoot(): string {
  const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
  return path.join(bunInstall, "install", "global", "node_modules");
}

export async function resolveGlobalRoot(
  manager: GlobalInstallManager,
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<string | null> {
  if (manager === "bun") {
    return resolveBunGlobalRoot();
  }
  const argv = manager === "pnpm" ? ["pnpm", "root", "-g"] : ["npm", "root", "-g"];
  const res = await runCommand(argv, { timeoutMs }).catch(() => null);
  if (!res || res.code !== 0) {
    return null;
  }
  const root = res.stdout.trim();
  return root || null;
}

export async function resolveGlobalPackageRoot(
  manager: GlobalInstallManager,
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<string | null> {
  const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
  if (!root) {
    return null;
  }
  return path.join(root, PRIMARY_PACKAGE_NAME);
}

export async function detectGlobalInstallManagerForRoot(
  runCommand: CommandRunner,
  pkgRoot: string,
  timeoutMs: number,
): Promise<GlobalInstallManager | null> {
  const pkgReal = await tryRealpath(pkgRoot);

  const candidates: Array<{
    manager: "npm" | "pnpm";
    argv: string[];
  }> = [
    { manager: "npm", argv: ["npm", "root", "-g"] },
    { manager: "pnpm", argv: ["pnpm", "root", "-g"] },
  ];

  for (const { manager, argv } of candidates) {
    const res = await runCommand(argv, { timeoutMs }).catch(() => null);
    if (!res || res.code !== 0) {
      continue;
    }
    const globalRoot = res.stdout.trim();
    if (!globalRoot) {
      continue;
    }
    const globalReal = await tryRealpath(globalRoot);
    for (const name of ALL_PACKAGE_NAMES) {
      const expected = path.join(globalReal, name);
      const expectedReal = await tryRealpath(expected);
      if (path.resolve(expectedReal) === path.resolve(pkgReal)) {
        return manager;
      }
    }
  }

  const bunGlobalRoot = resolveBunGlobalRoot();
  const bunGlobalReal = await tryRealpath(bunGlobalRoot);
  for (const name of ALL_PACKAGE_NAMES) {
    const bunExpected = path.join(bunGlobalReal, name);
    const bunExpectedReal = await tryRealpath(bunExpected);
    if (path.resolve(bunExpectedReal) === path.resolve(pkgReal)) {
      return "bun";
    }
  }

  return null;
}

export async function detectGlobalInstallManagerByPresence(
  runCommand: CommandRunner,
  timeoutMs: number,
): Promise<GlobalInstallManager | null> {
  for (const manager of ["npm", "pnpm"] as const) {
    const root = await resolveGlobalRoot(manager, runCommand, timeoutMs);
    if (!root) {
      continue;
    }
    for (const name of ALL_PACKAGE_NAMES) {
      if (await pathExists(path.join(root, name))) {
        return manager;
      }
    }
  }

  const bunRoot = resolveBunGlobalRoot();
  for (const name of ALL_PACKAGE_NAMES) {
    if (await pathExists(path.join(bunRoot, name))) {
      return "bun";
    }
  }
  return null;
}

export function globalInstallArgs(manager: GlobalInstallManager, spec: string): string[] {
  if (manager === "pnpm") {
    return ["pnpm", "add", "-g", spec];
  }
  if (manager === "bun") {
    return ["bun", "add", "-g", spec];
  }
  return ["npm", "i", "-g", spec, ...NPM_GLOBAL_INSTALL_QUIET_FLAGS];
}

export function globalInstallFallbackArgs(
  manager: GlobalInstallManager,
  spec: string,
): string[] | null {
  if (manager !== "npm") {
    return null;
  }
  return ["npm", "i", "-g", spec, ...NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS];
}

/**
 * Walks `pkgRoot` looking for files not owned by the current user.
 * Returns early once MAX_FOREIGN_FILES are found to avoid scanning
 * very large directories. On Windows (where `stat.uid` is always 0)
 * this check is a no-op.
 */
export async function checkPackageOwnership(
  pkgRoot: string,
  opts?: { uid?: number; maxDepth?: number },
): Promise<OwnershipCheckResult> {
  const currentUid = opts?.uid ?? process.getuid?.() ?? -1;
  const maxDepth = opts?.maxDepth ?? 8;
  const MAX_FOREIGN_FILES = 10;

  // On Windows getuid() is not available; skip the check.
  if (currentUid < 0) {
    return { ok: true, foreignFiles: [], currentUid };
  }

  const foreignFiles: string[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth || foreignFiles.length >= MAX_FOREIGN_FILES) {
      return;
    }
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (foreignFiles.length >= MAX_FOREIGN_FILES) {
        return;
      }
      if (entry === "node_modules") {
        continue;
      }
      const full = path.join(dir, entry);
      try {
        const stat = await fs.lstat(full);
        if (stat.uid !== currentUid) {
          foreignFiles.push(full);
          continue;
        }
        if (stat.isDirectory()) {
          await walk(full, depth + 1);
        }
      } catch {
        // permission denied or gone; skip
      }
    }
  }

  await walk(pkgRoot, 0);
  return { ok: foreignFiles.length === 0, foreignFiles, currentUid };
}

export function formatOwnershipError(pkgRoot: string, result: OwnershipCheckResult): string {
  const sample = result.foreignFiles.slice(0, 5).join("\n  ");
  const extra = result.foreignFiles.length > 5 ? `\n  ... and more` : "";
  return [
    `Cannot update: ${result.foreignFiles.length} file(s) in ${pkgRoot} are not owned by the current user (uid ${result.currentUid}).`,
    `  ${sample}${extra}`,
    `Fix with: sudo chown -R $(whoami) ${pkgRoot}`,
  ].join("\n");
}

export async function cleanupGlobalRenameDirs(params: {
  globalRoot: string;
  packageName: string;
}): Promise<{ removed: string[] }> {
  const removed: string[] = [];
  const root = params.globalRoot.trim();
  const name = params.packageName.trim();
  if (!root || !name) {
    return { removed };
  }
  const prefix = `${GLOBAL_RENAME_PREFIX}${name}-`;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return { removed };
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) {
      continue;
    }
    const target = path.join(root, entry);
    try {
      const stat = await fs.lstat(target);
      if (!stat.isDirectory()) {
        continue;
      }
      await fs.rm(target, { recursive: true, force: true });
      removed.push(entry);
    } catch {
      // ignore cleanup failures
    }
  }
  return { removed };
}
