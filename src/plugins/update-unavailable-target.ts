// Decides whether an unavailable npm update target may keep the installed payload.
import { formatCliCommand } from "../cli/command-format.js";
import { isUnavailablePluginSource } from "./install-channel-specs.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "./install.js";
import { listUnresolvedHostSdkImports } from "./installed-sdk-imports.js";
import type { PackageManifest } from "./manifest.js";
import { hasRunnableInstalledNpmPayload } from "./update-config.js";
import { isNpmMetadataCompatibleWithCurrentHost } from "./update-source.js";

export type UnavailableNpmTargetDecision =
  | { retained: true; message: string }
  | { retained: false; message: string; installedPayloadRunnable: boolean };

/**
 * Official packages are pinned to the core release. A retained official payload
 * whose `openclaw/plugin-sdk/*` imports this host removed would fail every load,
 * so retention refuses it with an actionable message. An inconclusive scan keeps
 * the existing retention behavior.
 */
async function describeStaleOfficialSdkImports(params: {
  pluginId: string;
  installPath: string;
  packageName: unknown;
  currentVersion: string;
  targetSpec: string | undefined;
  coreVersion: string | undefined;
  reason: string;
}): Promise<string | undefined> {
  if (typeof params.packageName !== "string" || !params.packageName.startsWith("@openclaw/")) {
    return undefined;
  }
  const unresolved = await listUnresolvedHostSdkImports({ packageDir: params.installPath });
  if (!unresolved?.length) {
    return undefined;
  }
  const host = params.coreVersion ? `OpenClaw ${params.coreVersion}` : "this OpenClaw";
  const retry = formatCliCommand(`openclaw plugins update ${params.pluginId}`);
  return (
    `Cannot keep "${params.pluginId}" at ${params.packageName}@${params.currentVersion}: it imports ` +
    `${unresolved.join(", ")}, which ${host} no longer exports, so the plugin would fail to load. ` +
    `Target ${params.targetSpec ?? params.packageName} is unavailable: ${params.reason} ` +
    `Run "${retry}" once the target is published or registry access recovers.`
  );
}

export async function resolveUnavailableNpmTarget(params: {
  pluginId: string;
  message: string;
  code?: string;
  retainOnUnavailable: boolean;
  disableOnFailure?: boolean;
  dryRun?: boolean;
  coreVersion?: string;
  currentVersion?: string;
  installedManifest: PackageManifest | undefined;
  installPath: string;
  effectiveSpec: string | undefined;
}): Promise<UnavailableNpmTargetDecision> {
  const { pluginId, message, code, retainOnUnavailable, currentVersion } = params;
  let installedPayloadRunnable = false;
  if (
    (code === PLUGIN_INSTALL_ERROR_CODE.NPM_METADATA_FAILURE ||
      (retainOnUnavailable && isUnavailablePluginSource("npm", { ok: false, code }))) &&
    (params.disableOnFailure || retainOnUnavailable) &&
    !params.dryRun &&
    currentVersion
  ) {
    const compatible =
      !retainOnUnavailable ||
      isNpmMetadataCompatibleWithCurrentHost(
        { packageOpenClaw: params.installedManifest?.openclaw },
        { hostVersion: params.coreVersion, allowLegacyBareSemver: true },
      );
    try {
      installedPayloadRunnable =
        compatible &&
        (await hasRunnableInstalledNpmPayload({
          installPath: params.installPath,
          manifest: params.installedManifest,
        }));
    } catch {
      // Damaged or unreadable payloads do not qualify for retention.
    }
  }
  if (!retainOnUnavailable || !installedPayloadRunnable || !currentVersion) {
    return { retained: false, message, installedPayloadRunnable };
  }
  const staleSdkFailure = await describeStaleOfficialSdkImports({
    pluginId,
    installPath: params.installPath,
    packageName: params.installedManifest?.name,
    currentVersion,
    targetSpec: params.effectiveSpec,
    coreVersion: params.coreVersion,
    reason: message,
  });
  if (staleSdkFailure) {
    return { retained: false, message: staleSdkFailure, installedPayloadRunnable: false };
  }
  return {
    retained: true,
    message:
      `Retained "${pluginId}" at ${currentVersion}: target ${params.effectiveSpec}` +
      `${params.coreVersion ? ` for OpenClaw ${params.coreVersion}` : ""} is unavailable. ${message} ` +
      `Retry "${formatCliCommand(`openclaw plugins update ${pluginId}`)}" after the target is published or registry access recovers.`,
  };
}
