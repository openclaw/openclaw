import fs from "node:fs/promises";
import type { ExtractedArchiveVerification } from "../infra/install-flow.js";
import { resolveUserPath } from "../utils.js";
import {
  inspectBundlePluginArtifact,
  inspectNativePluginArtifact,
} from "./install-artifact-inspection.js";
import {
  scanAndLinkInstalledPackage,
  validatePackagePluginInstallSource,
} from "./install-installed-package.js";
import { encodePluginInstallDirName, validatePluginId } from "./install-paths.js";
import {
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  ensureOpenClawExtensions,
  installPluginDirectoryIntoExtensions,
  loadPluginInstallRuntime,
  readOptionalPackageManifest,
  resolvePreparedDirectoryInstallTarget,
  runInstallSourceScan,
  sourceFamilyForInstallPolicyKind,
  validateOpenClawPackageInstallCompatibility,
  type PreparedInstallTarget,
} from "./install-shared.js";
import {
  attachPluginInstallTransaction,
  copyPluginInstallTransactionRequest,
  resolvePluginInstallTransaction,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import { installPluginMcpDependencies } from "./install-mcp-dependencies.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type InternalPackageInstallCommonParams,
  type PackageInstallCommonParams,
  type PluginInstallPolicyRequest,
} from "./install-types.js";

const PLUGIN_ARCHIVE_ROOT_MARKERS = [
  "package.json",
  "openclaw.plugin.json",
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  "plugin.json",
];

function installPolicyRequestForPath(
  params: PackageInstallCommonParams & { path: string },
  kind: PluginInstallPolicyRequest["kind"],
): PluginInstallPolicyRequest {
  const requestKind =
    params.installPolicyRequest?.kind === "plugin-git" && kind === "plugin-dir"
      ? "plugin-git"
      : kind;
  return {
    kind: requestKind,
    requestedSpecifier: params.installPolicyRequest?.requestedSpecifier ?? params.path,
    source: params.installPolicyRequest?.source ?? localPluginInstallPolicySource(requestKind),
  };
}

function localPluginInstallPolicySource(kind: PluginInstallPolicyRequest["kind"]) {
  if (kind === "plugin-archive") {
    return { kind: "archive", authority: "user", mutable: true, network: false } as const;
  }
  if (kind === "plugin-git") {
    return { kind: "git", authority: "third-party", mutable: true, network: true } as const;
  }
  return { kind: "local-path", authority: "user", mutable: true, network: false } as const;
}

async function installBundleFromSourceDir(
  params: {
    sourceDir: string;
  } & InternalPackageInstallCommonParams,
): Promise<InstallPluginResult | null> {
  const runtime = await loadPluginInstallRuntime();
  const bundleFormat = runtime.detectBundleManifestFormat(params.sourceDir);
  if (!bundleFormat) {
    return null;
  }

  const { logger, timeoutMs, workTimeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
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
  const packageManifestResult = await readOptionalPackageManifest({
    runtime,
    packageDir: params.sourceDir,
  });
  if (!packageManifestResult.ok) {
    return packageManifestResult;
  }
  const packageMetadata = packageManifestResult.manifest
    ? runtime.getPackageManifestMetadata(packageManifestResult.manifest)
    : undefined;
  const compatibilityError = validateOpenClawPackageInstallCompatibility({
    runtime,
    pluginId,
    packageMetadata,
  });
  if (compatibilityError) {
    return compatibilityError;
  }

  const targetResult = await resolvePreparedDirectoryInstallTarget({
    runtime,
    pluginId,
    extensionsDir: params.extensionsDir,
    requestedMode: mode,
  });
  if (!targetResult.ok) {
    return { ok: false, error: targetResult.error };
  }
  params.onEffectiveMode?.(targetResult.target.effectiveMode);

  const scanResult = await runInstallSourceScan({
    subject: `Bundle "${pluginId}"`,
    pluginId,
    mode: targetResult.target.effectiveMode,
    sourceFamily: sourceFamilyForInstallPolicyKind(params.installPolicyRequest?.kind, "archive"),
    scan: async () =>
      await runtime.scanBundleInstallSource({
        onInstallPolicyWarning: params.onInstallPolicyWarning,
        config: params.config,
        sourceDir: params.sourceDir,
        pluginId,
        logger,
        requestKind: params.installPolicyRequest?.kind,
        requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
        source: params.installPolicyRequest?.source,
        mode: targetResult.target.effectiveMode,
        version: manifestRes.manifest.version,
      }),
  });
  if (scanResult) {
    return scanResult;
  }

  const installed = await installPluginDirectoryIntoExtensions(
    copyPluginInstallTransactionRequest(params, {
      sourceDir: params.sourceDir,
      pluginId,
      manifestName: manifestRes.manifest.name,
      version: manifestRes.manifest.version,
      extensions: [],
      targetDir: targetResult.target.targetPath,
      logger,
      timeoutMs,
      workTimeoutMs,
      mode: targetResult.target.effectiveMode,
      dryRun,
      copyErrorPrefix: "failed to copy plugin bundle",
      hasDeps: false,
      depsLogMessage: "",
      onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
      beforePersistentApply: params.beforePersistentApply,
    }),
  );
  return installed.ok
    ? {
        ...installed,
        artifactInspection: inspectBundlePluginArtifact({
          format: manifestRes.manifest.bundleFormat,
          capabilities: manifestRes.manifest.capabilities,
        }),
      }
    : installed;
}

async function installPluginFromSourceDir(
  params: {
    sourceDir: string;
  } & InternalPackageInstallCommonParams,
): Promise<InstallPluginResult> {
  const runtime = await loadPluginInstallRuntime();
  const packageManifestResult = await readOptionalPackageManifest({
    runtime,
    packageDir: params.sourceDir,
  });
  const manifest = packageManifestResult.ok ? packageManifestResult.manifest : undefined;
  const nativePackageManifest =
    manifest && ensureOpenClawExtensions({ manifest }).ok ? manifest : undefined;
  if (!nativePackageManifest) {
    const bundleResult = await installBundleFromSourceDir(params);
    if (bundleResult) {
      return bundleResult;
    }
  }
  const { logger, timeoutMs, workTimeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  let preparedTarget: PreparedInstallTarget | undefined;
  const resolvePreparedTargetForPluginId = async (pluginId: string) => {
    if (!preparedTarget) {
      const targetResult = await resolvePreparedDirectoryInstallTarget({
        runtime,
        pluginId,
        extensionsDir: params.extensionsDir,
        requestedMode: mode,
        nameEncoder: encodePluginInstallDirName,
      });
      if (!targetResult.ok) {
        throw new Error(targetResult.error);
      }
      preparedTarget = targetResult.target;
    }
    return preparedTarget;
  };

  const validated = await validatePackagePluginInstallSource({
    runtime,
    packageDir: params.sourceDir,
    manifest: nativePackageManifest,
    expectedPluginId: params.expectedPluginId,
    requirePluginManifest: params.requirePluginManifest,
    allowSourceTypeScriptEntries: params.allowSourceTypeScriptEntries,
    onInstallPolicyWarning: params.onInstallPolicyWarning,
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    config: params.config,
    installPolicyRequest: params.installPolicyRequest,
    logger,
    mode,
    resolveEffectiveMode: async (pluginId) =>
      (await resolvePreparedTargetForPluginId(pluginId)).effectiveMode,
  });
  if (!validated.ok) {
    return validated;
  }
  const { plugin } = validated;

  preparedTarget = await resolvePreparedTargetForPluginId(plugin.pluginId);
  const effectiveMode = preparedTarget.effectiveMode;
  params.onEffectiveMode?.(effectiveMode);
  const shouldInstallRuntimeDeps =
    plugin.hasRuntimeDependencies && params.installPolicyRequest?.kind === "plugin-archive";

  const result = await installPluginDirectoryIntoExtensions(
    copyPluginInstallTransactionRequest(params, {
      sourceDir: params.sourceDir,
      pluginId: plugin.pluginId,
      manifestName: plugin.manifestName,
      version: plugin.version,
      extensions: plugin.extensions,
      setup: plugin.setup,
      mcpServers: plugin.mcpServers,
      targetDir: preparedTarget.targetPath,
      logger,
      timeoutMs,
      workTimeoutMs,
      mode: effectiveMode,
      dryRun,
      copyErrorPrefix: "failed to copy plugin",
      hasDeps: shouldInstallRuntimeDeps,
      sourceHardlinks: shouldInstallRuntimeDeps ? "package-manager" : "reject",
      depsLogMessage: "Installing plugin dependencies…",
      onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
      beforePersistentApply: params.beforePersistentApply,
      afterInstall: (installedDir) =>
        scanAndLinkInstalledPackage({
          runtime,
          installedDir,
          pluginId: plugin.pluginId,
          peerDependencies: plugin.peerDependencies,
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
          config: params.config,
          mode: effectiveMode,
          ...(params.installPolicyRequest?.kind
            ? { requestKind: params.installPolicyRequest.kind }
            : {}),
          requestedSpecifier: params.installPolicyRequest?.requestedSpecifier,
          source: params.installPolicyRequest?.source,
          logger,
        }),
    }),
  );
  if (!result.ok) {
    return result;
  }
  const transaction = resolvePluginInstallTransaction(result);
  if (transaction) {
    const wrappedTransaction: PluginInstallTransaction = {
      commit: async () => {
        if (!dryRun && plugin.mcpServers) {
          const dependencyResult = await installPluginMcpDependencies({
            pluginId: plugin.pluginId,
            mcpServers: plugin.mcpServers,
            config: params.config,
            timeoutMs,
            logger,
          });
          if (!dependencyResult.ok) {
            await transaction.rollback();
            throw new Error(dependencyResult.error);
          }
        }
        await transaction.commit();
      },
      rollback: () => transaction.rollback(),
    };
    return attachPluginInstallTransaction(
      { ...result, artifactInspection: inspectNativePluginArtifact() },
      wrappedTransaction,
    );
  }
  if (!dryRun && plugin.mcpServers) {
    const dependencyResult = await installPluginMcpDependencies({
      pluginId: plugin.pluginId,
      mcpServers: plugin.mcpServers,
      config: params.config,
      timeoutMs,
      logger,
    });
    if (!dependencyResult.ok) {
      return dependencyResult;
    }
  }
  return { ...result, artifactInspection: inspectNativePluginArtifact() };
}

export async function installPluginFromArchive<
  TFailure extends { ok: false; error: string; code?: string } = never,
>(
  params: {
    archivePath: string;
    verification?: ExtractedArchiveVerification<TFailure>;
  } & PackageInstallCommonParams,
): Promise<InstallPluginResult | NoInfer<TFailure>> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, workTimeoutMs, mode } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const installPolicyRequest = params.installPolicyRequest ?? {
    kind: "plugin-archive",
    requestedSpecifier: params.archivePath,
    source: localPluginInstallPolicySource("plugin-archive"),
  };
  const archivePathResult = await runtime.resolveArchiveSourcePath(params.archivePath);
  if (!archivePathResult.ok) {
    return archivePathResult;
  }
  const archivePath = archivePathResult.path;
  let effectiveMode = mode;

  const result = await runtime.withExtractedArchiveRoot({
    archivePath,
    tempDirPrefix: "openclaw-plugin-",
    timeoutMs,
    workTimeoutMs,
    logger,
    verification: params.verification,
    rootMarkers: PLUGIN_ARCHIVE_ROOT_MARKERS,
    onExtracted: async (sourceDir) =>
      await installPluginFromSourceDir(
        copyPluginInstallTransactionRequest(params, {
          sourceDir,
          onInstallPolicyWarning: params.onInstallPolicyWarning,
          extensionsDir: params.extensionsDir,
          timeoutMs,
          workTimeoutMs,
          logger,
          mode,
          dryRun: params.dryRun,
          config: params.config,
          expectedPluginId: params.expectedPluginId,
          trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
          requirePluginManifest: true,
          installPolicyRequest,
          onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
          beforePersistentApply: params.beforePersistentApply,
          onEffectiveMode: (resolvedMode) => {
            effectiveMode = resolvedMode;
          },
        }),
      ),
  });
  if (result.ok) {
    emitSuccessfulPluginInstallSecurityEvent(result, {
      dryRun: params.dryRun,
      mode: effectiveMode,
      sourceFamily: "archive",
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    });
  }
  return result;
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

  if (stat.isDirectory()) {
    const dirPath = resolveUserPath(resolved);
    const installPolicyRequest = installPolicyRequestForPath(params, "plugin-dir");
    if (!(await runtime.fileExists(dirPath))) {
      return { ok: false, error: `directory not found: ${dirPath}` };
    }
    const currentStat = await fs.stat(dirPath);
    if (!currentStat.isDirectory()) {
      return { ok: false, error: `not a directory: ${dirPath}` };
    }
    let effectiveMode = params.mode ?? "install";
    const result = await installPluginFromSourceDir({
      ...params,
      sourceDir: dirPath,
      installPolicyRequest,
      onEffectiveMode: (resolvedMode) => {
        effectiveMode = resolvedMode;
      },
    });
    emitSuccessfulPluginInstallSecurityEvent(result, {
      dryRun: params.dryRun,
      mode: effectiveMode,
      sourceFamily: sourceFamilyForInstallPolicyKind(installPolicyRequest.kind, "directory"),
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    });
    return result;
  }

  const archiveKind = runtime.resolveArchiveKind(resolved);
  if (archiveKind) {
    return await installPluginFromArchive({
      ...params,
      archivePath: resolved,
      installPolicyRequest: installPolicyRequestForPath(params, "plugin-archive"),
    });
  }

  return {
    ok: false,
    code: PLUGIN_INSTALL_ERROR_CODE.UNSUPPORTED_PLAIN_FILE_PLUGIN,
    error:
      "Plain file plugin installs are not supported. Install a plugin directory or archive that contains openclaw.plugin.json, or list standalone plugin files in plugins.load.paths.",
  };
}
