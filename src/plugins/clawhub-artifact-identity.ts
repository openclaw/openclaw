import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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
} from "../infra/clawhub-packages.js";
import { readInstalledPackageManifest } from "../infra/package-update-utils.js";
import { resolveUserPath } from "../utils.js";
import { normalizeClawHubClawPackInstallFields } from "./clawhub-install-records.js";
import type { ClawHubInstallArtifactDecision, installPluginFromClawHub } from "./clawhub.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "./manifest.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import { auditDeclaredOpenClawHostDependency } from "./plugin-peer-link.js";

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
  params: Parameters<typeof installPluginFromClawHub>[0],
  resolved: {
    detail: ClawHubPackageDetail;
    versionState: ClawHubInstallArtifactDecision;
    expectedPluginId?: string;
    clawhubFamily: "code-plugin" | "bundle-plugin";
  },
  expectedIntegrity: string | null | undefined,
  warning?: string,
): Promise<
  Extract<Awaited<ReturnType<typeof installPluginFromClawHub>>, { ok: true }> | undefined
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
  // Match npm's unchanged-artifact policy: trust the install ledger's digest,
  // check entrypoints and host links, and leave other file repair to explicit reinstall.
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
    const manifest = readInstalledPackageManifest(targetDir) as PackageManifest | undefined;
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
