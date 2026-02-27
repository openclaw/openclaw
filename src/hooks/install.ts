import fs from "node:fs/promises";
import path from "node:path";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { fileExists, readJsonFile, resolveArchiveKind } from "../infra/archive.js";
import { resolveExistingInstallPath, withExtractedArchiveRoot } from "../infra/install-flow.js";
import {
  resolveInstallModeOptions,
  resolveTimedInstallModeOptions,
} from "../infra/install-mode-options.js";
import { installPackageDir } from "../infra/install-package-dir.js";
import { resolveSafeInstallDir, unscopedPackageName } from "../infra/install-safe-path.js";
import {
  type NpmIntegrityDrift,
  type NpmSpecResolution,
  resolveArchiveSourcePath,
} from "../infra/install-source-utils.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchiveWithInstaller,
} from "../infra/npm-pack-install.js";
import { validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { isPathInside, isPathInsideWithRealpath } from "../security/scan-paths.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { parseFrontmatter } from "./frontmatter.js";

export type HookInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type HookPackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
} & Partial<Record<typeof MANIFEST_KEY, { hooks?: string[] }>>;

export type InstallHooksResult =
  | {
      ok: true;
      hookPackId: string;
      hooks: string[];
      targetDir: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string };

export type HookNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

const defaultLogger: HookInstallLogger = {};

function validateHookId(hookId: string): string | null {
  if (!hookId) {
    return "invalid hook name: missing";
  }
  if (hookId === "." || hookId === "..") {
    return "invalid hook name: reserved path segment";
  }
  if (hookId.includes("/") || hookId.includes("\\")) {
    return "invalid hook name: path separators not allowed";
  }
  return null;
}

export function resolveHookInstallDir(hookId: string, hooksDir?: string): string {
  const hooksBase = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  const hookIdError = validateHookId(hookId);
  if (hookIdError) {
    throw new Error(hookIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: hooksBase,
    id: hookId,
    invalidNameMessage: "invalid hook name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function ensureOpenClawHooks(manifest: HookPackageManifest) {
  const hooks = manifest[MANIFEST_KEY]?.hooks;
  if (!Array.isArray(hooks)) {
    throw new Error("package.json missing openclaw.hooks");
  }
  const list = hooks.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
  if (list.length === 0) {
    throw new Error("package.json openclaw.hooks is empty");
  }
  return list;
}

async function resolveInstallTargetDir(
  id: string,
  hooksDir?: string,
): Promise<{ ok: true; targetDir: string } | { ok: false; error: string }> {
  const baseHooksDir = hooksDir ? resolveUserPath(hooksDir) : path.join(CONFIG_DIR, "hooks");
  await fs.mkdir(baseHooksDir, { recursive: true });

  const targetDirResult = resolveSafeInstallDir({
    baseDir: baseHooksDir,
    id,
    invalidNameMessage: "invalid hook name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  return { ok: true, targetDir: targetDirResult.path };
}

async function resolveHookNameFromDir(hookDir: string): Promise<string> {
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }
  const raw = await fs.readFile(hookMdPath, "utf-8");
  const frontmatter = parseFrontmatter(raw);
  return frontmatter.name || path.basename(hookDir);
}

async function validateHookDir(hookDir: string): Promise<void> {
  const hookMdPath = path.join(hookDir, "HOOK.md");
  if (!(await fileExists(hookMdPath))) {
    throw new Error(`HOOK.md missing in ${hookDir}`);
  }

  const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
  const hasHandler = await Promise.all(
    handlerCandidates.map(async (candidate) => fileExists(path.join(hookDir, candidate))),
  ).then((results) => results.some(Boolean));

  if (!hasHandler) {
    throw new Error(`handler.ts/handler.js/index.ts/index.js missing in ${hookDir}`);
  }
}

async function installHookPackageFromDir(params: {
  packageDir: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "package.json missing" };
  }

  let manifest: HookPackageManifest;
  try {
    manifest = await readJsonFile<HookPackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  let hookEntries: string[];
  try {
    hookEntries = await ensureOpenClawHooks(manifest);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const hookPackId = pkgName ? unscopedPackageName(pkgName) : path.basename(params.packageDir);
  const hookIdError = validateHookId(hookPackId);
  if (hookIdError) {
    return { ok: false, error: hookIdError };
  }
  if (params.expectedHookPackId && params.expectedHookPackId !== hookPackId) {
    return {
      ok: false,
      error: `hook pack id mismatch: expected ${params.expectedHookPackId}, got ${hookPackId}`,
    };
  }

  const targetDirResult = await resolveInstallTargetDir(hookPackId, params.hooksDir);
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  const targetDir = targetDirResult.targetDir;
  if (mode === "install" && (await fileExists(targetDir))) {
    return { ok: false, error: `hook pack already exists: ${targetDir} (delete it first)` };
  }

  const resolvedHooks = [] as string[];
  for (const entry of hookEntries) {
    const hookDir = path.resolve(params.packageDir, entry);
    if (!isPathInside(params.packageDir, hookDir)) {
      return {
        ok: false,
        error: `openclaw.hooks entry escapes package directory: ${entry}`,
      };
    }
    await validateHookDir(hookDir);
    if (
      !isPathInsideWithRealpath(params.packageDir, hookDir, {
        requireRealpath: true,
      })
    ) {
      return {
        ok: false,
        error: `openclaw.hooks entry resolves outside package directory: ${entry}`,
      };
    }
    const hookName = await resolveHookNameFromDir(hookDir);
    resolvedHooks.push(hookName);
  }

  if (dryRun) {
    return {
      ok: true,
      hookPackId,
      hooks: resolvedHooks,
      targetDir,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
    };
  }

  const deps = manifest.dependencies ?? {};
  const hasDeps = Object.keys(deps).length > 0;
  const installRes = await installPackageDir({
    sourceDir: params.packageDir,
    targetDir,
    mode,
    timeoutMs,
    logger,
    copyErrorPrefix: "failed to copy hook pack",
    hasDeps,
    depsLogMessage: "Installing hook pack dependencies…",
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    ok: true,
    hookPackId,
    hooks: resolvedHooks,
    targetDir,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
  };
}

async function installHookFromDir(params: {
  hookDir: string;
  hooksDir?: string;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const { logger, mode, dryRun } = resolveInstallModeOptions(params, defaultLogger);

  await validateHookDir(params.hookDir);
  const hookName = await resolveHookNameFromDir(params.hookDir);
  const hookIdError = validateHookId(hookName);
  if (hookIdError) {
    return { ok: false, error: hookIdError };
  }

  if (params.expectedHookPackId && params.expectedHookPackId !== hookName) {
    return {
      ok: false,
      error: `hook id mismatch: expected ${params.expectedHookPackId}, got ${hookName}`,
    };
  }

  const targetDirResult = await resolveInstallTargetDir(hookName, params.hooksDir);
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  const targetDir = targetDirResult.targetDir;
  if (mode === "install" && (await fileExists(targetDir))) {
    return { ok: false, error: `hook already exists: ${targetDir} (delete it first)` };
  }

  if (dryRun) {
    return { ok: true, hookPackId: hookName, hooks: [hookName], targetDir };
  }

  logger.info?.(`Installing to ${targetDir}…`);
  let backupDir: string | null = null;
  if (mode === "update" && (await fileExists(targetDir))) {
    backupDir = `${targetDir}.backup-${Date.now()}`;
    await fs.rename(targetDir, backupDir);
  }

  try {
    await fs.cp(params.hookDir, targetDir, { recursive: true });
  } catch (err) {
    if (backupDir) {
      await fs.rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rename(backupDir, targetDir).catch(() => undefined);
    }
    return { ok: false, error: `failed to copy hook: ${String(err)}` };
  }

  if (backupDir) {
    await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { ok: true, hookPackId: hookName, hooks: [hookName], targetDir };
}

export async function installHooksFromArchive(params: {
  archivePath: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-hook-",
    timeoutMs,
    logger,
    onExtracted: async (rootDir) => {
      const manifestPath = path.join(rootDir, "package.json");
      if (await fileExists(manifestPath)) {
        return await installHookPackageFromDir({
          packageDir: rootDir,
          hooksDir: params.hooksDir,
          timeoutMs,
          logger,
          mode: params.mode,
          dryRun: params.dryRun,
          expectedHookPackId: params.expectedHookPackId,
        });
      }

      return await installHookFromDir({
        hookDir: rootDir,
        hooksDir: params.hooksDir,
        logger,
        mode: params.mode,
        dryRun: params.dryRun,
        expectedHookPackId: params.expectedHookPackId,
      });
    },
  });
}

export async function installHooksFromNpmSpec(params: {
  spec: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
  expectedIntegrity?: string;
  onIntegrityDrift?: (params: HookNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallHooksResult> {
  const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
  const expectedHookPackId = params.expectedHookPackId;
  const spec = params.spec.trim();
  const specError = validateRegistryNpmSpec(spec);
  if (specError) {
    return { ok: false, error: specError };
  }

  logger.info?.(`Downloading ${spec}…`);
  const flowResult = await installFromNpmSpecArchiveWithInstaller({
    tempDirPrefix: "openclaw-hook-pack-",
    spec,
    timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => {
      logger.warn?.(message);
    },
    installFromArchive: installHooksFromArchive,
    archiveInstallParams: {
      hooksDir: params.hooksDir,
      timeoutMs,
      logger,
      mode,
      dryRun,
      expectedHookPackId,
    },
  });
  return finalizeNpmSpecArchiveInstall(flowResult);
}

export async function installHooksFromPath(params: {
  path: string;
  hooksDir?: string;
  timeoutMs?: number;
  logger?: HookInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedHookPackId?: string;
}): Promise<InstallHooksResult> {
  const pathResult = await resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;

  if (stat.isDirectory()) {
    const manifestPath = path.join(resolved, "package.json");
    if (await fileExists(manifestPath)) {
      return await installHookPackageFromDir({
        packageDir: resolved,
        hooksDir: params.hooksDir,
        timeoutMs: params.timeoutMs,
        logger: params.logger,
        mode: params.mode,
        dryRun: params.dryRun,
        expectedHookPackId: params.expectedHookPackId,
      });
    }

    return await installHookFromDir({
      hookDir: resolved,
      hooksDir: params.hooksDir,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedHookPackId: params.expectedHookPackId,
    });
  }

  if (!resolveArchiveKind(resolved)) {
    return { ok: false, error: `unsupported hook file: ${resolved}` };
  }

  return await installHooksFromArchive({
    archivePath: resolved,
    hooksDir: params.hooksDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedHookPackId: params.expectedHookPackId,
  });
}
