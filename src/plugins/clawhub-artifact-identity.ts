import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveClawHubBaseUrl } from "../infra/clawhub-client.js";
import {
  normalizeClawHubSha256Hex,
  normalizeClawHubSha256Integrity,
} from "../infra/clawhub-integrity.js";
import type {
  ClawHubPackageArtifactSummary,
  ClawHubPackageClawPackSummary,
  ClawHubPackageDetail,
  ClawHubPackageArtifactResolverResponse,
  ClawHubPackageCompatibility,
} from "../infra/clawhub-packages.js";
import { readInstalledPackageManifest } from "../infra/package-update-utils.js";
import { resolveUserPath } from "../utils.js";
import type { ClawHubFileVerificationEntry } from "./clawhub-archive-verification.js";
import { normalizeClawHubClawPackInstallFields } from "./clawhub-install-records.js";
import type { ClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import type { InstallPluginResult } from "./install-types.js";
import { resolvePackageExtensionEntries } from "./manifest.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import { auditDeclaredOpenClawHostDependency } from "./plugin-peer-link.js";

export type ClawHubArchiveVerification =
  | {
      kind: "archive-integrity";
      integrity: string;
    }
  | {
      kind: "file-list";
      files: ClawHubFileVerificationEntry[];
    };

export type ClawHubInstallArtifactDecision = {
  version: string;
  compatibility?: ClawHubPackageCompatibility | null;
  verification: ClawHubArchiveVerification | null;
  clawpack?: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null;
};

export type ClawHubArtifactResolverVersion = NonNullable<
  Exclude<ClawHubPackageArtifactResolverResponse["version"], string | null | undefined>
>;

export function resolveClawHubNpmPackArtifact(
  version: Pick<ClawHubArtifactResolverVersion, "artifact" | "clawpack">,
): ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null {
  if (version.artifact?.kind === "npm-pack") {
    return version.artifact;
  }
  if (version.clawpack?.available === true) {
    return version.clawpack;
  }
  return null;
}

export function resolveClawHubClawPackArtifactSha256(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): string | null {
  const isNpmPackArtifact =
    clawpack && "kind" in clawpack && normalizeOptionalString(clawpack.kind) === "npm-pack";
  const isLegacyClawPack = clawpack && "available" in clawpack && clawpack.available;
  if ((!isNpmPackArtifact && !isLegacyClawPack) || typeof clawpack.sha256 !== "string") {
    return null;
  }
  return normalizeClawHubSha256Hex(clawpack.sha256);
}

export async function retainCurrentClawHubInstall(
  params: {
    mode?: "install" | "update";
    dryRun?: boolean;
    baseUrl?: string;
    currentInstall?: PluginInstallRecord;
    canRetainCurrentArtifact?: () => boolean;
  },
  resolved: {
    detail: ClawHubPackageDetail;
    versionState: ClawHubInstallArtifactDecision;
    expectedPluginId?: string;
    clawhubFamily: "code-plugin" | "bundle-plugin";
  },
  expectedIntegrity: string | null | undefined,
  warning?: string,
): Promise<
  | (Extract<InstallPluginResult, { ok: true }> & {
      packageName: string;
      clawhub: ClawHubPluginInstallRecordFields;
      unchanged: true;
      warning?: string;
    })
  | undefined
> {
  const { detail, versionState, expectedPluginId, clawhubFamily } = resolved;
  const expectedClawPackSha256 = resolveClawHubClawPackArtifactSha256(versionState.clawpack);
  const canonicalPackageName = detail.package?.name;
  const current = params.currentInstall;
  const clawpackFields = normalizeClawHubClawPackInstallFields(versionState.clawpack);
  const resolvedIntegrity = expectedClawPackSha256
    ? normalizeClawHubSha256Integrity(expectedClawPackSha256)
    : versionState.verification?.kind === "archive-integrity"
      ? versionState.verification.integrity
      : undefined;
  // Identity alone cannot retain damaged manifests or stale capability acceptance.
  if (
    params.mode === "update" &&
    !params.dryRun &&
    expectedPluginId &&
    canonicalPackageName &&
    current?.source === "clawhub" &&
    current.installPath &&
    current.clawhubUrl === resolveClawHubBaseUrl(params.baseUrl) &&
    current.clawhubPackage === canonicalPackageName &&
    current.clawhubFamily === clawhubFamily &&
    current.version === versionState.version &&
    resolvedIntegrity &&
    current.integrity === resolvedIntegrity &&
    (!clawpackFields.npmIntegrity || current.npmIntegrity === clawpackFields.npmIntegrity) &&
    (!clawpackFields.npmShasum || current.npmShasum === clawpackFields.npmShasum) &&
    (!expectedIntegrity || expectedIntegrity === resolvedIntegrity)
  ) {
    const targetDir = resolveUserPath(current.installPath);
    const manifest = readInstalledPackageManifest(targetDir);
    const extensions = resolvePackageExtensionEntries(manifest);
    if (
      manifest?.name === canonicalPackageName &&
      manifest.version === versionState.version &&
      extensions.status === "ok" &&
      (
        await validatePackageExtensionEntriesForInstall({
          packageDir: targetDir,
          extensions: extensions.entries,
          manifest,
        })
      ).ok &&
      params.canRetainCurrentArtifact?.() &&
      !(await auditDeclaredOpenClawHostDependency({
        packageDir: targetDir,
        packageName: canonicalPackageName,
      }))
    ) {
      return {
        ok: true,
        unchanged: true,
        pluginId: expectedPluginId,
        targetDir,
        version: versionState.version,
        extensions: extensions.entries,
        packageName: canonicalPackageName,
        ...(warning ? { warning } : {}),
        clawhub: {
          ...current,
          source: "clawhub",
          clawhubUrl: resolveClawHubBaseUrl(params.baseUrl),
          clawhubPackage: canonicalPackageName,
          clawhubFamily,
          clawhubChannel: detail.package!.channel,
          // Retaining the artifact also retains its recorded install and trust timestamps.
        },
      };
    }
  }

  return undefined;
}
