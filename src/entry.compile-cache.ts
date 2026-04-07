import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { enableCompileCache, getCompileCacheDir } from "node:module";
import os from "node:os";
import path from "node:path";

export const OPENCLAW_COMPILE_CACHE_DIR_ENV = "OPENCLAW_COMPILE_CACHE_DIR";

type EnableCompileCacheFn = (cacheDir?: string) => unknown;

export function resolveEntryInstallRoot(entryFile: string): string {
  const entryDir = path.dirname(entryFile);
  const entryParent = path.basename(entryDir);
  return entryParent === "dist" || entryParent === "src" ? path.dirname(entryDir) : entryDir;
}

export function isSourceCheckoutInstallRoot(installRoot: string): boolean {
  return (
    existsSync(path.join(installRoot, ".git")) ||
    existsSync(path.join(installRoot, "src", "entry.ts"))
  );
}

function isNodeCompileCacheDisabled(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_DISABLE_COMPILE_CACHE !== undefined;
}

function isNodeCompileCacheRequested(env: NodeJS.ProcessEnv | undefined): boolean {
  return env?.NODE_COMPILE_CACHE !== undefined && !isNodeCompileCacheDisabled(env);
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizeCompileCachePathSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return sanitized || fallback;
}

function hashCompileCacheInstallRoot(root: string): string {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 12);
}

function resolveCompileCacheBaseDir(env: NodeJS.ProcessEnv, tmpdir: () => string): string {
  const configured = trimToUndefined(env.NODE_COMPILE_CACHE);
  if (configured) {
    // OpenClaw scopes the Node cache under this configured base by install root and version.
    return path.resolve(configured);
  }
  return path.join(tmpdir(), "node-compile-cache", "openclaw");
}

export function resolveOpenClawCompileCacheDirectory(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
  version: string | undefined;
  tmpdir?: () => string;
}): string {
  return path.join(
    resolveCompileCacheBaseDir(params.env ?? process.env, params.tmpdir ?? os.tmpdir),
    hashCompileCacheInstallRoot(params.installRoot),
    sanitizeCompileCachePathSegment(params.version, "unknown-version"),
  );
}

export function prepareOpenClawCompileCacheDirectory(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
  version: string | undefined;
  tmpdir?: () => string;
}): string {
  const env = params.env ?? process.env;
  const prepared = trimToUndefined(env[OPENCLAW_COMPILE_CACHE_DIR_ENV]);
  if (prepared) {
    return prepared;
  }
  const directory = resolveOpenClawCompileCacheDirectory({ ...params, env });
  env[OPENCLAW_COMPILE_CACHE_DIR_ENV] = directory;
  return directory;
}

export function shouldEnableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}): boolean {
  if (isNodeCompileCacheDisabled(params.env)) {
    return false;
  }
  return !isSourceCheckoutInstallRoot(params.installRoot);
}

export type OpenClawCompileCacheRespawnPlan = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function buildOpenClawCompileCacheRespawnPlan(params: {
  currentFile: string;
  env?: NodeJS.ProcessEnv;
  execArgv?: string[];
  execPath?: string;
  installRoot: string;
  argv?: string[];
  compileCacheDir?: string;
}): OpenClawCompileCacheRespawnPlan | undefined {
  const env = params.env ?? process.env;
  if (!isSourceCheckoutInstallRoot(params.installRoot)) {
    return undefined;
  }
  if (env.OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED === "1") {
    return undefined;
  }
  if (!params.compileCacheDir && !isNodeCompileCacheRequested(env)) {
    return undefined;
  }
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_SOURCE_COMPILE_CACHE_RESPAWNED: "1",
  };
  delete nextEnv.NODE_COMPILE_CACHE;
  return {
    command: params.execPath ?? process.execPath,
    args: [
      ...(params.execArgv ?? process.execArgv),
      params.currentFile,
      ...(params.argv ?? process.argv).slice(2),
    ],
    env: nextEnv,
  };
}

export function respawnWithoutOpenClawCompileCacheIfNeeded(params: {
  currentFile: string;
  installRoot: string;
}): boolean {
  const plan = buildOpenClawCompileCacheRespawnPlan({
    currentFile: params.currentFile,
    installRoot: params.installRoot,
    compileCacheDir: getCompileCacheDir?.(),
  });
  if (!plan) {
    return false;
  }
  const result = spawnSync(plan.command, plan.args, {
    stdio: "inherit",
    env: plan.env,
  });
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
  return true;
}

export function enableOpenClawCompileCache(params: {
  env?: NodeJS.ProcessEnv;
  enableCompileCache?: EnableCompileCacheFn;
  installRoot: string;
  version: string | undefined;
  tmpdir?: () => string;
}): string | undefined {
  if (!shouldEnableOpenClawCompileCache(params)) {
    return undefined;
  }
  const directory = prepareOpenClawCompileCacheDirectory(params);
  try {
    (params.enableCompileCache ?? enableCompileCache)(directory);
  } catch {
    // Best-effort only; never block startup.
  }
  return directory;
}
