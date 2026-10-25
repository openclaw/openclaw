import fs from "node:fs/promises";
import path from "node:path";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import {
  resolveNpmPackArchiveMetadata,
  type NpmSpecResolution,
} from "../infra/install-source-utils.js";
import { resolveNpmIntegrityDriftWithDefaultMessage } from "../infra/npm-integrity.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveUserPath } from "../utils.js";
import { resolveManagedNpmInstallPlan } from "./install-managed-npm-state.js";
import { installPluginFromManagedNpmRoot } from "./install-managed-npm.js";
import { resolveDefaultPluginNpmDir, safePluginInstallFileName } from "./install-paths.js";
import {
  defaultLogger,
  emitSuccessfulPluginInstallSecurityEvent,
  loadPluginInstallRuntime,
} from "./install-shared.js";
import { copyPluginInstallTransactionRequest } from "./install-transaction.js";
import {
  PLUGIN_INSTALL_ERROR_CODE,
  type InstallPluginResult,
  type PackageInstallCommonParams,
  type PluginNpmIntegrityDriftParams,
} from "./install-types.js";

const MANAGED_NPM_PACK_ARCHIVE_DIR = "_openclaw-pack-archives";

export async function installPluginFromNpmPackArchive(
  params: Omit<
    PackageInstallCommonParams,
    "requirePluginManifest" | "allowSourceTypeScriptEntries" | "installPolicyRequest"
  > & {
    archivePath: string;
    signal?: AbortSignal;
    expectedIntegrity?: string;
    onIntegrityDrift?: (params: PluginNpmIntegrityDriftParams) => boolean | Promise<boolean>;
  },
): Promise<InstallPluginResult & { npmTarballName?: string }> {
  const runtime = await loadPluginInstallRuntime();
  const { logger, timeoutMs, workTimeoutMs, mode, dryRun } = runtime.resolveTimedInstallModeOptions(
    params,
    defaultLogger,
  );
  const metadataResult = await resolveNpmPackArchiveMetadata({
    archivePath: params.archivePath,
    timeoutMs,
    signal: params.signal,
  });
  if (!metadataResult.ok) {
    return metadataResult;
  }
  const npmResolution: NpmSpecResolution = {
    ...metadataResult.metadata,
    resolvedAt: new Date().toISOString(),
  };
  const driftResult = await resolveNpmIntegrityDriftWithDefaultMessage({
    spec: metadataResult.archivePath,
    expectedIntegrity: params.expectedIntegrity,
    resolution: npmResolution,
    onIntegrityDrift: params.onIntegrityDrift,
    warn: (message) => logger.warn?.(message),
  });
  if (driftResult.error) {
    return { ok: false, error: driftResult.error };
  }
  const metadataName = metadataResult.metadata.name;
  if (!metadataName) {
    return {
      ok: false,
      error: "npm pack metadata missing package name",
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }
  const parsedSpec = parseRegistryNpmSpec(metadataName);
  if (!parsedSpec || parsedSpec.selectorKind !== "none") {
    return {
      ok: false,
      error: `unsupported npm pack package name: ${metadataName}`,
      code: PLUGIN_INSTALL_ERROR_CODE.INVALID_NPM_SPEC,
    };
  }
  const packageName = parsedSpec.name;
  const npmBaseDir = params.npmDir ? resolveUserPath(params.npmDir) : resolveDefaultPluginNpmDir();
  const { policyMode } = await resolveManagedNpmInstallPlan({
    runtime,
    npmBaseDir,
    packageName,
    requestedMode: mode,
    npmResolution,
  });

  const result = await installPluginFromManagedNpmRoot(
    copyPluginInstallTransactionRequest(params, {
      onInstallPolicyWarning: params.onInstallPolicyWarning,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
      config: params.config,
      packageName,
      prepareDependencySpec: async ({ npmRoot }) => {
        try {
          const archivePath = metadataResult.archivePath;
          const archiveStoreDir = path.join(npmRoot, MANAGED_NPM_PACK_ARCHIVE_DIR);
          const identity =
            metadataResult.metadata.integrity ??
            metadataResult.metadata.shasum ??
            metadataResult.tarballName;
          const identitySlug = sha256HexPrefixCore(identity, 16);
          const packageSlug = safePluginInstallFileName(packageName) || "plugin";
          const versionSlug =
            safePluginInstallFileName(metadataResult.metadata.version ?? "pack") || "pack";
          const archiveFileName = `${packageSlug}-${versionSlug}-${identitySlug}.tgz`;
          await fs.mkdir(archiveStoreDir, { recursive: true });
          await fs.copyFile(archivePath, path.join(archiveStoreDir, archiveFileName));
          return `file:./${path.posix.join(MANAGED_NPM_PACK_ARCHIVE_DIR, archiveFileName)}`;
        } catch (error) {
          throw new Error(
            `Failed to stage npm pack archive in managed npm root: ${String(error)}`,
            {
              cause: error,
            },
          );
        }
      },
      displaySpec: metadataResult.archivePath,
      installPolicyRequest: {
        kind: "plugin-npm",
        requestedSpecifier: `npm-pack:${metadataResult.archivePath}`,
        source: { kind: "archive", authority: "user", mutable: true, network: false },
      },
      policyPreflightSourcePath: metadataResult.archivePath,
      extensionsDir: params.extensionsDir,
      npmDir: npmBaseDir,
      timeoutMs,
      workTimeoutMs,
      signal: params.signal,
      logger,
      mode,
      dryRun,
      expectedPluginId: params.expectedPluginId,
      onBeforePluginArtifactCommit: params.onBeforePluginArtifactCommit,
      beforePersistentApply: params.beforePersistentApply,
      npmResolution,
    }),
  );
  emitSuccessfulPluginInstallSecurityEvent(result, {
    dryRun,
    mode: policyMode,
    sourceFamily: "archive",
    trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
  });
  return {
    ...result,
    ...(result.ok ? { npmTarballName: metadataResult.tarballName } : {}),
  };
}
