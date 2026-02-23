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
import {
  resolveSafeInstallDir,
  safeDirName,
  unscopedPackageName,
} from "../infra/install-safe-path.js";
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
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import * as skillScanner from "../security/skill-scanner.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
} & Partial<Record<typeof MANIFEST_KEY, { extensions?: string[] }>>;

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | { ok: false; error: string };

export type PluginNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

const defaultLogger: PluginInstallLogger = {};
function safeFileName(input: string): string {
  return safeDirName(input);
}

function validatePluginId(pluginId: string): string | null {
  if (!pluginId) {
    return "invalid plugin name: missing";
  }
  if (pluginId === "." || pluginId === "..") {
    return "invalid plugin name: reserved path segment";
  }
  if (pluginId.includes("/") || pluginId.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  return null;
}

async function ensureOpenClawExtensions(manifest: PackageManifest) {
  const extensions = manifest[MANIFEST_KEY]?.extensions;
  if (!Array.isArray(extensions)) {
    throw new Error("package.json missing openclaw.extensions");
  }
  const list = extensions.map((e) => (typeof e === "string" ? e.trim() : "")).filter(Boolean);
  if (list.length === 0) {
    throw new Error("package.json openclaw.extensions is empty");
  }
  return list;
}

function buildFileInstallResult(pluginId: string, targetFile: string): InstallPluginResult {
  return {
    ok: true,
    pluginId,
    targetDir: targetFile,
    manifestName: undefined,
    version: undefined,
    extensions: [path.basename(targetFile)],
  };
}

export function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string {
  const extensionsBase = extensionsDir
    ? resolveUserPath(extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    throw new Error(pluginIdError);
  }
  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsBase,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function installPluginFromPackageDir(params: {
  packageDir: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await readJsonFile<PackageManifest>(manifestPath);
  } catch (err) {
    return { ok: false, error: `invalid package.json: ${String(err)}` };
  }

  let extensions: string[];
  try {
    extensions = await ensureOpenClawExtensions(manifest);
  } catch (err) {
    return { ok: false, error: String(err) };
  }

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const pluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  if (params.expectedPluginId && params.expectedPluginId !== pluginId) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
    };
  }

  const packageDir = path.resolve(params.packageDir);
  const forcedScanEntries: string[] = [];
  for (const entry of extensions) {
    const resolvedEntry = path.resolve(packageDir, entry);
    if (!isPathInside(packageDir, resolvedEntry)) {
      logger.warn?.(`extension entry escapes plugin directory and will not be scanned: ${entry}`);
      continue;
    }
    if (extensionUsesSkippedScannerPath(entry)) {
      logger.warn?.(
        `extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`,
      );
    }
    forcedScanEntries.push(resolvedEntry);
  }

  // Scan plugin source for dangerous code patterns (warn-only; never blocks install)
  try {
    const scanSummary = await skillScanner.scanDirectoryWithSummary(params.packageDir, {
      includeFiles: forcedScanEntries,
    });
    if (scanSummary.critical > 0) {
      const criticalDetails = scanSummary.findings
        .filter((f) => f.severity === "critical")
        .map((f) => `${f.message} (${f.file}:${f.line})`)
        .join("; ");
      logger.warn?.(
        `WARNING: Plugin "${pluginId}" contains dangerous code patterns: ${criticalDetails}`,
      );
    } else if (scanSummary.warn > 0) {
      logger.warn?.(
        `Plugin "${pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
      );
    }
  } catch (err) {
    logger.warn?.(
      `Plugin "${pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const targetDirResult = resolveSafeInstallDir({
    baseDir: extensionsDir,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
  });
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  const targetDir = targetDirResult.path;

  if (mode === "install" && (await fileExists(targetDir))) {
    return {
      ok: false,
      error: `plugin already exists: ${targetDir} (delete it first)`,
    };
  }

  if (dryRun) {
    return {
      ok: true,
      pluginId,
      targetDir,
      manifestName: pkgName || undefined,
      version: typeof manifest.version === "string" ? manifest.version : undefined,
      extensions,
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
    copyErrorPrefix: "failed to copy plugin",
    hasDeps,
    depsLogMessage: "Installing plugin dependencies…",
    afterCopy: async () => {
      for (const entry of extensions) {
        const resolvedEntry = path.resolve(targetDir, entry);
        if (!isPathInside(targetDir, resolvedEntry)) {
          logger.warn?.(`extension entry escapes plugin directory: ${entry}`);
          continue;
        }
        if (!(await fileExists(resolvedEntry))) {
          logger.warn?.(`extension entry not found: ${entry}`);
        }
      }
    },
  });
  if (!installRes.ok) {
    return installRes;
  }

  return {
    ok: true,
    pluginId,
    targetDir,
    manifestName: pkgName || undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    extensions,
  };
}

export async function installPluginFromArchive(params: {
  archivePath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const archivePathResult = await resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-plugin-",
    timeoutMs,
    logger,
    onExtracted: async (packageDir) =>
      await installPluginFromPackageDir({
        packageDir,
        extensionsDir: params.extensionsDir,
        timeoutMs,
        logger,
        mode,
        dryRun: params.dryRun,
        expectedPluginId: params.expectedPluginId,
      }),
  });
}

export async function installPluginFromDir(params: {
  dirPath: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const dirPath = resolveUserPath(params.dirPath);
  if (!(await fileExists(dirPath))) {
    return { ok: false, error: `directory not found: ${dirPath}` };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${dirPath}` };
  }

  return await installPluginFromPackageDir({
    packageDir: dirPath,
    extensionsDir: params.extensionsDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
  });
}

export async function installPluginFromFile(params: {
  filePath: string;
  extensionsDir?: string;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
}): Promise<InstallPluginResult> {
  const { logger, mode, dryRun } = resolveInstallModeOptions(params, defaultLogger);

  const filePath = resolveUserPath(params.filePath);
  if (!(await fileExists(filePath))) {
    return { ok: false, error: `file not found: ${filePath}` };
  }

  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  await fs.mkdir(extensionsDir, { recursive: true });

  const base = path.basename(filePath, path.extname(filePath));
  const pluginId = base || "plugin";
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  const targetFile = path.join(extensionsDir, `${safeFileName(pluginId)}${path.extname(filePath)}`);

  if (mode === "install" && (await fileExists(targetFile))) {
    return { ok: false, error: `plugin already exists: ${targetFile} (delete it first)` };
  }

  if (dryRun) {
    return buildFileInstallResult(pluginId, targetFile);
  }

  logger.info?.(`Installing to ${targetFile}…`);
  await fs.copyFile(filePath, targetFile);

  return buildFileInstallResult(pluginId, targetFile);
}

export async function installPluginFromNpmSpec(params: {
  spec: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  expectedIntegrity?: string;
  onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
}): Promise<InstallPluginResult> {
  const { logger, timeoutMs, mode, dryRun } = resolveTimedInstallModeOptions(params, defaultLogger);
  const expectedPluginId = params.expectedPluginId;
  const spec = params.spec.trim();
  const specError = validateRegistryNpmSpec(spec);
  if (specError) {
    return { ok: false, error: specError };
  }

  logger.info?.(`Downloading ${spec}…`);
  const flowResult = await installFromNpmSpecArchiveWithInstaller({
    tempDirPrefix: "openclaw-npm-pack-",
    spec,
    timeoutMs,
    expectedIntegrity: params.expectedIntegrity,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => {
      logger.warn?.(message);
    },
    installFromArchive: installPluginFromArchive,
    archiveInstallParams: {
      extensionsDir: params.extensionsDir,
      timeoutMs,
      logger,
      mode,
      dryRun,
      expectedPluginId,
    },
  });
  return finalizeNpmSpecArchiveInstall(flowResult);
}

export async function installPluginFromPath(params: {
  path: string;
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
}): Promise<InstallPluginResult> {
  const pathResult = await resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;

  if (stat.isDirectory()) {
    return await installPluginFromDir({
      dirPath: resolved,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
  }

  const archiveKind = resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      extensionsDir: params.extensionsDir,
      timeoutMs: params.timeoutMs,
      logger: params.logger,
      mode: params.mode,
      dryRun: params.dryRun,
      expectedPluginId: params.expectedPluginId,
    });
  }

  return await installPluginFromFile({
    filePath: resolved,
    extensionsDir: params.extensionsDir,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
  });
}
