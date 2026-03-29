import fs from "node:fs/promises";
import path from "node:path";
import type { InstallCodeSafetyMode } from "../infra/install-code-safety-mode.js";
import {
  resolveSafeInstallDir,
  safeDirName,
  safePathSegmentHashed,
  unscopedPackageName,
} from "../infra/install-safe-path.js";
import { type NpmIntegrityDrift, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import {
  resolvePackageExtensionEntries,
  type PackageManifest as PluginPackageManifest,
} from "./manifest.js";

let pluginInstallRuntimePromise: Promise<typeof import("./install.runtime.js")> | undefined;

async function loadPluginInstallRuntime() {
  pluginInstallRuntimePromise ??= import("./install.runtime.js");
  return pluginInstallRuntimePromise;
}

type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

type PackageManifest = PluginPackageManifest & {
  dependencies?: Record<string, string>;
};

const MISSING_EXTENSIONS_ERROR =
  'package.json missing openclaw.extensions; update the plugin package to include openclaw.extensions (for example ["./dist/index.js"]). See https://docs.openclaw.ai/help/troubleshooting#plugin-install-fails-with-missing-openclaw-extensions';
const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  "package.json",
  "openclaw.plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
];

export const PLUGIN_INSTALL_ERROR_CODE = {
  INVALID_NPM_SPEC: "invalid_npm_spec",
  INVALID_MIN_HOST_VERSION: "invalid_min_host_version",
  UNKNOWN_HOST_VERSION: "unknown_host_version",
  INCOMPATIBLE_HOST_VERSION: "incompatible_host_version",
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

function encodePluginInstallDirName(pluginId: string): string {
  const trimmed = pluginId.trim();
  if (!trimmed.includes("/")) {
    return safeDirName(trimmed);
  }
  // Scoped plugin ids need a reserved on-disk namespace so they cannot collide
  // with valid unscoped ids that happen to match the hashed slug.
  return `@${safePathSegmentHashed(trimmed)}`;
}

function validatePluginId(pluginId: string): string | null {
  const trimmed = pluginId.trim();
  if (!trimmed) {
    return "invalid plugin name: missing";
  }
  if (trimmed.includes("\\")) {
    return "invalid plugin name: path separators not allowed";
  }
  const segments = trimmed.split("/");
  if (segments.some((segment) => !segment)) {
    return "invalid plugin name: malformed scope";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "invalid plugin name: reserved path segment";
  }
  if (segments.length === 1) {
    if (trimmed.startsWith("@")) {
      return "invalid plugin name: scoped ids must use @scope/name format";
    }
    return null;
  }
  if (segments.length !== 2) {
    return "invalid plugin name: path separators not allowed";
  }
  if (!segments[0]?.startsWith("@") || segments[0].length < 2) {
    return "invalid plugin name: scoped ids must use @scope/name format";
  }
  return null;
}

function matchesExpectedPluginId(params: {
  expectedPluginId?: string;
  pluginId: string;
  manifestPluginId?: string;
  npmPluginId: string;
}): boolean {
  if (!params.expectedPluginId) {
    return true;
  }
  if (params.expectedPluginId === params.pluginId) {
    return true;
  }
  // Backward compatibility: older install records keyed scoped npm packages by
  // their unscoped package name. Preserve update-in-place for those records
  // unless the package declares an explicit manifest id override.
  return (
    !params.manifestPluginId &&
    params.pluginId === params.npmPluginId &&
    params.expectedPluginId === unscopedPackageName(params.npmPluginId)
  );
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

function buildDirectoryInstallResult(params: {
  pluginId: string;
  targetDir: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
}): InstallPluginResult {
  return {
    ok: true,
    pluginId: params.pluginId,
    targetDir: params.targetDir,
    manifestName: params.manifestName,
    version: params.version,
    extensions: params.extensions,
  };
}

type PackageInstallCommonParams = {
  codeSafetyMode?: InstallCodeSafetyMode;
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
    codeSafetyMode: params.codeSafetyMode,
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

async function installPluginDirectoryIntoExtensions(params: {
  sourceDir: string;
  pluginId: string;
  manifestName?: string;
  version?: string;
  extensions: string[];
  extensionsDir?: string;
  logger: PluginInstallLogger;
  timeoutMs: number;
  mode: "install" | "update";
  dryRun: boolean;
  copyErrorPrefix: string;
  hasDeps: boolean;
  depsLogMessage: string;
  afterCopy?: (installedDir: string) => Promise<void>;
  nameEncoder?: (pluginId: string) => string;
}): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const extensionsDir = params.extensionsDir
    ? resolveUserPath(params.extensionsDir)
    : path.join(CONFIG_DIR, "extensions");
  const targetDirResult = await runtime.resolveCanonicalInstallTarget({
    baseDir: extensionsDir,
    id: params.pluginId,
    invalidNameMessage: "invalid plugin name: path traversal detected",
    boundaryLabel: "extensions directory",
    nameEncoder: params.nameEncoder,
  });
  if (!targetDirResult.ok) {
    return { ok: false, error: targetDirResult.error };
  }
  const targetDir = targetDirResult.targetDir;
  const availability = await runtime.ensureInstallTargetAvailable({
    mode: params.mode,
    targetDir,
    alreadyExistsError: `plugin already exists: ${targetDir} (delete it first)`,
  });
  if (!availability.ok) {
    return availability;
  }

  if (params.dryRun) {
    return buildDirectoryInstallResult({
      pluginId: params.pluginId,
      targetDir,
      manifestName: params.manifestName,
      version: params.version,
      extensions: params.extensions,
    });
  }

  const installRes = await runtime.installPackageDir({
    sourceDir: params.sourceDir,
    targetDir,
    mode: params.mode,
    timeoutMs: params.timeoutMs,
    logger: params.logger,
    copyErrorPrefix: params.copyErrorPrefix,
    hasDeps: params.hasDeps,
    depsLogMessage: params.depsLogMessage,
    afterCopy: params.afterCopy,
  });
  if (!installRes.ok) {
    return installRes;
  }

  return buildDirectoryInstallResult({
    pluginId: params.pluginId,
    targetDir,
    manifestName: params.manifestName,
    version: params.version,
    extensions: params.extensions,
  });
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
    nameEncoder: encodePluginInstallDirName,
  });
  if (!targetDirResult.ok) {
    throw new Error(targetDirResult.error);
  }
  return targetDirResult.path;
}

async function installBundleFromSourceDir(
  params: {
    sourceDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult | null> {
  const runtime = await loadPluginInstallRuntime();
  const bundleFormat = runtime.detectBundleManifestFormat(params.sourceDir);
  if (!bundleFormat) {
    return null;
  }

  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const manifestRes = runtime.loadBundleManifest({
    rootDir: params.sourceDir,
    bundleFormat,
    rejectHardlinks: true,
  });
  if (!manifestRes.ok) {
    return { ok: false, error: manifestRes.error };
  }

  const pluginId = manifestRes.manifest.id;
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

  const bundleScanBlockError = await runtime
    .scanBundleInstallSource({
      codeSafetyMode: params.codeSafetyMode,
      sourceDir: params.sourceDir,
      pluginId,
      logger,
    })
    .catch((err) => {
      logger.warn?.(
        `Bundle "${pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
      );
      return null;
    });
  if (bundleScanBlockError) {
    return { ok: false, error: bundleScanBlockError };
  }

  return await installPluginDirectoryIntoExtensions({
    sourceDir: params.sourceDir,
    pluginId,
    manifestName: manifestRes.manifest.name,
    version: manifestRes.manifest.version,
    extensions: [],
    extensionsDir: params.extensionsDir,
    logger,
    timeoutMs,
    mode,
    dryRun,
    copyErrorPrefix: "failed to copy plugin bundle",
    hasDeps: false,
    depsLogMessage: "",
  });
}

async function installPluginFromSourceDir(
  params: {
    sourceDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const nativePackageDetected = await detectNativePackageInstallSource(params.sourceDir);
  if (nativePackageDetected) {
    return await installPluginFromPackageDir({
      packageDir: params.sourceDir,
      ...pickPackageInstallCommonParams(params),
    });
  }
  const bundleResult = await installBundleFromSourceDir({
    sourceDir: params.sourceDir,
    ...pickPackageInstallCommonParams(params),
  });
  if (bundleResult) {
    return bundleResult;
  }
  return await installPluginFromPackageDir({
    packageDir: params.sourceDir,
    ...pickPackageInstallCommonParams(params),
  });
}

async function detectNativePackageInstallSource(packageDir: string): Promise<boolean> {
  const runtime = await loadPluginInstallRuntime();
  const manifestPath = path.join(packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return false;
  }

  try {
    const manifest = await runtime.readJsonFile<PackageManifest>(manifestPath);
    return ensureOpenClawExtensions({ manifest }).ok;
  } catch {
    return false;
  }
}

async function installPluginFromPackageDir(
  params: {
    packageDir: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );

  const manifestPath = path.join(params.packageDir, "package.json");
  if (!(await runtime.fileExists(manifestPath))) {
    return { ok: false, error: "extracted package missing package.json" };
  }

  let manifest: PackageManifest;
  try {
    manifest = await runtime.readJsonFile<PackageManifest>(manifestPath);
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

  const pkgName = typeof manifest.name === "string" ? manifest.name.trim() : "";
  const npmPluginId = pkgName || "plugin";

  // Prefer the canonical `id` from openclaw.plugin.json over the npm package name.
  // This avoids a latent key-mismatch bug: if the manifest id (e.g. "memory-cognee")
  // differs from the npm package name (e.g. "cognee-openclaw"), the plugin registry
  // uses the manifest id as the authoritative key, so the config entry must match it.
  const ocManifestResult = runtime.loadPluginManifest(params.packageDir);
  const manifestPluginId =
    ocManifestResult.ok && ocManifestResult.manifest.id
      ? ocManifestResult.manifest.id.trim()
      : undefined;

  const pluginId = manifestPluginId ?? npmPluginId;
  const pluginIdError = validatePluginId(pluginId);
  if (pluginIdError) {
    return { ok: false, error: pluginIdError };
  }
  if (
    !matchesExpectedPluginId({
      expectedPluginId: params.expectedPluginId,
      pluginId,
      manifestPluginId,
      npmPluginId,
    })
  ) {
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

  const packageMetadata = runtime.getPackageManifestMetadata(manifest);
  const minHostVersionCheck = runtime.checkMinHostVersion({
    currentVersion: runtime.resolveCompatibilityHostVersion(),
    minHostVersion: packageMetadata?.install?.minHostVersion,
  });
  if (!minHostVersionCheck.ok) {
    if (minHostVersionCheck.kind === "invalid") {
      return {
        ok: false,
        error: `invalid package.json openclaw.install.minHostVersion: ${minHostVersionCheck.error}`,
        code: PLUGIN_INSTALL_ERROR_CODE.INVALID_MIN_HOST_VERSION,
      };
    }
    if (minHostVersionCheck.kind === "unknown_host_version") {
      return {
        ok: false,
        error: `plugin "${pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.`,
        code: PLUGIN_INSTALL_ERROR_CODE.UNKNOWN_HOST_VERSION,
      };
    }
    return {
      ok: false,
      error: `plugin "${pluginId}" requires OpenClaw >=${minHostVersionCheck.requirement.minimumLabel}, but this host is ${minHostVersionCheck.currentVersion}. Upgrade OpenClaw and retry.`,
      code: PLUGIN_INSTALL_ERROR_CODE.INCOMPATIBLE_HOST_VERSION,
    };
  }
  try {
    const packageScanBlockError = await runtime.scanPackageInstallSource({
      codeSafetyMode: params.codeSafetyMode,
      packageDir: params.packageDir,
      pluginId,
      logger,
      extensions,
    });
    if (packageScanBlockError) {
      return { ok: false, error: packageScanBlockError };
    }
  } catch (err) {
    logger.warn?.(
      `Plugin "${pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }

  const deps = manifest.dependencies ?? {};
  return await installPluginDirectoryIntoExtensions({
    sourceDir: params.packageDir,
    pluginId,
    manifestName: pkgName || undefined,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    extensions,
    extensionsDir: params.extensionsDir,
    logger,
    timeoutMs,
    mode,
    dryRun,
    copyErrorPrefix: "failed to copy plugin",
    hasDeps: Object.keys(deps).length > 0,
    depsLogMessage: "Installing plugin dependencies…",
    nameEncoder: encodePluginInstallDirName,
    afterCopy: async (installedDir) => {
      for (const entry of extensions) {
        const resolvedEntry = path.resolve(installedDir, entry);
        if (!runtime.isPathInside(installedDir, resolvedEntry)) {
          logger.warn?.(`extension entry escapes plugin directory: ${entry}`);
          continue;
        }
        if (!(await runtime.fileExists(resolvedEntry))) {
          logger.warn?.(`extension entry not found: ${entry}`);
        }
      }
    },
  });
}

export async function installPluginFromArchive(
  params: {
    archivePath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const logger = params.logger ?? defaultLogger;
  const timeoutMs = params.timeoutMs ?? 120_000;
  const mode = params.mode ?? "install";
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;

  return await runtime.withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-plugin-",
    timeoutMs,
    logger,
    rootMarkers: PLUGIN_ARCHIVE_ROOT_MARKERS,
    onExtracted: async (sourceDir) =>
      await installPluginFromSourceDir({
        sourceDir,
        ...pickPackageInstallCommonParams({
          extensionsDir: params.extensionsDir,
          timeoutMs,
          logger,
          mode,
          dryRun: params.dryRun,
          expectedPluginId: params.expectedPluginId,
          codeSafetyMode: params.codeSafetyMode,
        }),
      }),
  });
}

export async function installPluginFromDir(
  params: {
    dirPath: string;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const dirPath = resolveUserPath(params.dirPath);
  if (!(await runtime.fileExists(dirPath))) {
    return { ok: false, error: `directory not found: ${dirPath}` };
  }
  const stat = await fs.stat(dirPath);
  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${dirPath}` };
  }

  return await installPluginFromSourceDir({
    sourceDir: dirPath,
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
  const runtime = await loadPluginInstallRuntime();
  const { logger, mode, dryRun } = runtime.resolveInstallModeOptions(params, defaultLogger);

  const filePath = resolveUserPath(params.filePath);
  if (!(await runtime.fileExists(filePath))) {
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

  const availability = await runtime.ensureInstallTargetAvailable({
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
    await runtime.writeFileFromPathWithinRoot({
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
  codeSafetyMode?: InstallCodeSafetyMode;
}): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const expectedPluginId = params.expectedPluginId;
  const spec = params.spec.trim();
  const specError = runtime.validateRegistryNpmSpec(spec);
  if (specError) {
    return {
      ok: false,
      error: specError,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }

  logger.info?.(`Downloading ${spec}…`);
  const flowResult = await runtime.installFromNpmSpecArchiveWithInstaller({
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
      codeSafetyMode: params.codeSafetyMode,
    },
  });
  const finalized = runtime.finalizeNpmSpecArchiveInstall(flowResult);
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
  const runtime = await loadPluginInstallRuntime();
  const pathResult = await runtime.resolveExistingInstallPath(params.path);
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

  const archiveKind = runtime.resolveArchiveKind(resolved);
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
