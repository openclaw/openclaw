import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathExists } from "../utils.js";
import { applyPathPrepend } from "./path-prepend.js";

export type GlobalInstallManager = "npm" | "pnpm" | "bun";

export type CommandRunner = (
  argv: string[],
  options: { timeoutMs: number; cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

const PRIMARY_PACKAGE_NAME = "@qverisai/qverisbot";
const LEGACY_PACKAGE_NAME = "openclaw";
const LEGACY_PACKAGE_NAME_UNSCOPED = "qverisbot";
const ALL_PACKAGE_NAMES = [
  PRIMARY_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME,
  LEGACY_PACKAGE_NAME_UNSCOPED,
] as const;
const GLOBAL_RENAME_PREFIX = ".";
const NPM_GLOBAL_INSTALL_QUIET_FLAGS = ["--no-fund", "--no-audit", "--loglevel=error"] as const;
const NPM_GLOBAL_INSTALL_OMIT_OPTIONAL_FLAGS = [
  "--omit=optional",
  ...NPM_GLOBAL_INSTALL_QUIET_FLAGS,
] as const;

async function resolvePortableGitPathPrepend(
  env: NodeJS.ProcessEnv | undefined,
): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const localAppData = env?.LOCALAPPDATA?.trim() || process.env.LOCALAPPDATA?.trim();
  if (!localAppData) {
    return [];
  }
  const portableGitRoot = path.join(localAppData, "OpenClaw", "deps", "portable-git");
  const candidates = [
    path.join(portableGitRoot, "mingw64", "bin"),
    path.join(portableGitRoot, "usr", "bin"),
    path.join(portableGitRoot, "cmd"),
    path.join(portableGitRoot, "bin"),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      existing.push(candidate);
    }
  }
  return existing;
}

function applyWindowsPackageInstallEnv(env: Record<string, string>) {
  if (process.platform !== "win32") {
    return;
  }
  env.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  env.NPM_CONFIG_FUND = "false";
  env.NPM_CONFIG_AUDIT = "false";
  env.NPM_CONFIG_SCRIPT_SHELL = "cmd.exe";
  env.NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1";
}

export function resolveGlobalInstallSpec(params: {
  packageName: string;
  tag: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const override =
    params.env?.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim() ||
    process.env.OPENCLAW_UPDATE_PACKAGE_SPEC?.trim();
  if (override) {
    return override;
  }
  return `${params.packageName}@${params.tag}`;
}

export async function createGlobalInstallEnv(
  env?: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv | undefined> {
  const pathPrepend = await resolvePortableGitPathPrepend(env);
  if (pathPrepend.length === 0 && process.platform !== "win32") {
    return env;
  }
  const merged = Object.fromEntries(
    Object.entries(env ?? process.env)
      .filter(([, value]) => value != null)
      .map(([key, value]) => [key, String(value)]),
  ) as Record<string, string>;
  applyPathPrepend(merged, pathPrepend);
  applyWindowsPackageInstallEnv(merged);
  return merged;
}

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
