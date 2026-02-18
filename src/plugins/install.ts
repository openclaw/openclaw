import fs from "node:fs/promises";
import path from "node:path";
import { fileExists, readJsonFile, resolveArchiveKind } from "../infra/archive.js";
import { writeFileFromPathWithinRoot } from "../infra/fs-safe.js";
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
  ensureInstallTargetAvailable,
  resolveCanonicalInstallTarget,
} from "../infra/install-target.js";
import {
  finalizeNpmSpecArchiveInstall,
  installFromNpmSpecArchiveWithInstaller,
} from "../infra/npm-pack-install.js";
import { validateRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import * as skillScanner from "../security/skill-scanner.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  loadPluginManifest,
  resolvePackageExtensionEntries,
  type PackageManifest as PluginPackageManifest,
} from "./manifest.js";

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = PluginPackageManifest & {
  dependencies?: Record<string, string>;
};

const MISSING_EXTENSIONS_ERROR =
  'package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions';

export const PLUGIN_INSTALL_ERROR_CODE = {
  INVALID_NPM_SPEC: "invalid_npm_spec",
  MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
  EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
  NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
} as const;

export type PluginInstallErrorCode =
  (typeof PLUGIN_INSTALL_ERROR_CODE)[keyof typeof PLUGIN_INSTALL_ERROR_CODE];

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
  | { ok: false; error: string; code?: PluginInstallErrorCode };

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

function ensureOpenClawExtensions(params: { manifest: PackageManifest }):
  | {
      ok: true;
      entries: string[];
    }
  | {
      ok: false;
      error: string;
      code: PluginInstallErrorCode;
    } {
  const resolved = resolvePackageExtensionEntries(params.manifest);
  if (resolved.status === "missing") {
    return {
      ok: false,
      error: MISSING_EXTENSIONS_ERROR,
      code: PLUGIN_INSTALL_ERROR_CODE.MISSING_OPENCLAW_EXTENSIONS,
    };
  }
  if (resolved.status === "empty") {
    return {
      ok: false,
      error: "package.json openclaw.extensions is empty",
      code: PLUGIN_INSTALL_ERROR_CODE.EMPTY_OPENCLAW_EXTENSIONS,
    };
  }
  return {
    ok: true,
    entries: resolved.entries,
  };
}

function isNpmPackageNotFoundMessage(error: string): boolean {
  const normalized = error.trim();
  if (normalized.startsWith("Package not found on npm:")) {
    return true;
  }
  return /E404|404 not found|not in this registry/i.test(normalized);
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

type PackageInstallCommonParams = {
  extensionsDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
};

type FileInstallCommonParams = Pick<
  PackageInstallCommonParams,
  "extensionsDir" | "logger" | "mode" | "dryRun"
>;

function pickPackageInstallCommonParams(
  params: PackageInstallCommonParams,
): PackageInstallCommonParams {
  return {
    extensionsDir: params.extensionsDir,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
    expectedPluginId: params.expectedPluginId,
  };
}

function pickFileInstallCommonParams(params: FileInstallCommonParams): FileInstallCommonParams {
  return {
    extensionsDir: params.extensionsDir,
    logger: params.logger,
    mode: params.mode,
    dryRun: params.dryRun,
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

async function installPluginFromPackageDir(
  params: {
    packageDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
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

  const extensionsResult = ensureOpenClawExtensions({
    manifest,
  });
  if (!extensionsResult.ok) {
    return {
      ok: false,
      error: extensionsResult.error,
      code: extensionsResult.code,
    };
  }
  const extensions = extensionsResult.entries;

  const pkgName = typeof manifest.name === "string" ? manifest.name : "";
  const npmPluginId = pkgName ? unscopedPackageName(pkgName) : "plugin";

  // Prefer the canonical `id` from openclaw.plugin.json over the npm package name.
  // This avoids a latent key-mismatch bug: if the manifest id (e.g. "memory-cognee")
  // differs from the npm package name (e.g. "cognee-openclaw"), the plugin registry
  // uses the manifest id as the authoritative key, so the config entry must match it.
  const ocManifestResult = loadPluginManifest(params.packageDir);
  const manifestPluginId =
    ocManifestResult.ok && ocManifestResult.manifest.id
      ? unscopedPackageName(ocManifestResult.manifest.id)
      : undefined;

  const pluginId = manifestPluginId ?? npmPluginId;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  if (params.expectedPluginId && params.expectedPluginId !== pluginId) {
    return {
      ok: false,
      error: `plugin id mismatch: expected ${params.expectedPluginId}, got ${pluginId}`,
      code: PLUGIN_INSTALL_ERROR_CODE.PLUGIN_ID_MISMATCH,
    };
  }

  if (manifestPluginId && manifestPluginId !== npmPluginId) {
    logger.info?.(
      `Plugin manifest id "${manifestPluginId}" differs from npm package name "${npmPluginId}"; using manifest id as the config key.`,
    );
  }

  const packageDir = path.resolve(params.packageDir);
  const forcedScanEntries: string[] = [];
  const invalidExtensions: string[] = [];
  for (const entry of extensions) {
    const resolvedEntry = path.resolve(packageDir, entry);
    if (!isPathInside(packageDir, resolvedEntry)) {
      invalidExtensions.push(entry);
      continue;
    }
    if (extensionUsesSkippedScannerPath(entry)) {
      logger.warn?.(
        `extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`,
      );
    }
    forcedScanEntries.push(resolvedEntry);
  }

  if (invalidExtensions.length > 0) {
    return {
      ok: false,
      error: `openclaw.extensions entry escapes plugin directory: ${invalidExtensions.join(", ")}`,
    };
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
  const targetDirResult = await resolveCanonicalInstallTarget({
    baseDir: extensionsDir,
    id: pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    boundaryLabel: "extensions directory",
  });
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  const targetDir = targetDirResult.targetDir;
  const availability = await ensureInstallTargetAvailable({
    mode,
    targetDir,
    alreadyExistsError: `plugin already exists: ${targetDir} (delete it first)`,
  });
  if (!availability.ok) {
    return availability;
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
      for (const entry of forcedScanEntries) {
        const relativeEntry = path.relative(packageDir, entry);
        const installedEntry = path.join(targetDir, relativeEntry);
        if (!(await fileExists(installedEntry))) {
          logger.warn?.(`extension entry not found: ${relativeEntry}`);
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

export async function installPluginFromArchive(
  params: {
    archivePath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
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
        ...pickPackageInstallCommonParams({
          extensionsDir: params.extensionsDir,
          timeoutMs,
          logger,
          mode,
          dryRun: params.dryRun,
          expectedPluginId: params.expectedPluginId,
        }),
      }),
  });
}

export async function installPluginFromDir(
  params: {
    dirPath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
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
    ...pickPackageInstallCommonParams(params),
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

  const availability = await ensureInstallTargetAvailable({
    mode,
    targetDir: targetFile,
    alreadyExistsError: `plugin already exists: ${targetFile} (delete it first)`,
  });
  if (!availability.ok) {
    return availability;
  }

  if (dryRun) {
    return buildFileInstallResult(pluginId, targetFile);
  }

  logger.info?.(`Installing to ${targetFile}…`);
  try {
    await writeFileFromPathWithinRoot({
      rootDir: extensionsDir,
      relativePath: path.basename(targetFile),
      sourcePath: filePath,
    });
  } catch (err) {
    return { ok: false, error: String(err) };
  }

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
    return {
      ok: false,
      error: specError,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
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
  const finalized = finalizeNpmSpecArchiveInstall(flowResult);
  if (!finalized.ok && isNpmPackageNotFoundMessage(finalized.error)) {
    return {
      ok: false,
      error: finalized.error,
      code: PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND,
    };
  }
  return finalized;
}

export async function installPluginFromPath(
  params: {
    path: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const pathResult = await resolveExistingInstallPath(params.path);
  if (!pathResult.ok) {
    return pathResult;
  }
  const { resolvedPath: resolved, stat } = pathResult;
  const packageInstallOptions = pickPackageInstallCommonParams(params);

  if (stat.isDirectory()) {
    return await installPluginFromDir({
      dirPath: resolved,
      ...packageInstallOptions,
    });
  }

  const archiveKind = resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      archivePath: resolved,
      ...packageInstallOptions,
    });
  }

  return await installPluginFromFile({
    filePath: resolved,
    ...pickFileInstallCommonParams(params),
  });
}
