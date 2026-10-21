import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { normalizeClawHubSha256Hex } from "../infra/clawhub-integrity.js";
import type {
  ClawHubPackageArtifactSummary,
  ClawHubPackageChannel,
  ClawHubPackageClawPackSummary,
} from "../infra/clawhub-packages.js";

/** Install record fields captured for ClawHub plugin installs. */
export type ClawHubPluginInstallRecordFields = {
  source: "clawhub";
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: "code-plugin" | "bundle-plugin";
  clawhubChannel?: ClawHubPackageChannel;
  clawhubTrustDisposition?: "clean" | "review-recommended" | "review-required" | "blocked";
  clawhubTrustScanStatus?: string;
  clawhubTrustModerationState?: string;
  clawhubTrustReasons?: string[];
  clawhubTrustPending?: boolean;
  clawhubTrustStale?: boolean;
  clawhubTrustCheckedAt?: string;
  clawhubTrustAcknowledgedAt?: string;
  version?: string;
  integrity?: string;
  resolvedAt?: string;
  installedAt?: string;
  artifactKind?: "legacy-zip" | "npm-pack";
  artifactFormat?: "zip" | "tgz";
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  clawpackSha256?: string;
  clawpackSpecVersion?: number;
  clawpackManifestSha256?: string;
  clawpackSize?: number;
};

export function normalizeClawHubClawPackInstallFields(
  clawpack: ClawHubPackageArtifactSummary | ClawHubPackageClawPackSummary | null | undefined,
): Pick<
  ClawHubPluginInstallRecordFields,
  | "artifactKind"
  | "artifactFormat"
  | "npmIntegrity"
  | "npmShasum"
  | "npmTarballName"
  | "clawpackSha256"
  | "clawpackSpecVersion"
  | "clawpackManifestSha256"
  | "clawpackSize"
> {
  const isNpmPackArtifact =
    clawpack && "kind" in clawpack && normalizeOptionalString(clawpack.kind) === "npm-pack";
  const isLegacyClawPack = clawpack && "available" in clawpack && clawpack.available;
  if (!isNpmPackArtifact && !isLegacyClawPack) {
    return {};
  }

  const clawpackSha256 =
    typeof clawpack.sha256 === "string" ? normalizeClawHubSha256Hex(clawpack.sha256) : null;
  const clawpackManifestSha256 =
    "manifestSha256" in clawpack && typeof clawpack.manifestSha256 === "string"
      ? normalizeClawHubSha256Hex(clawpack.manifestSha256)
      : null;
  const clawpackSpecVersion =
    "specVersion" in clawpack &&
    typeof clawpack.specVersion === "number" &&
    Number.isSafeInteger(clawpack.specVersion) &&
    clawpack.specVersion >= 0
      ? clawpack.specVersion
      : undefined;
  const clawpackSize =
    typeof clawpack.size === "number" && Number.isSafeInteger(clawpack.size) && clawpack.size >= 0
      ? clawpack.size
      : undefined;
  const npmIntegrity = normalizeOptionalString(clawpack.npmIntegrity);
  const npmShasum = normalizeOptionalString(clawpack.npmShasum);
  const npmTarballName = normalizeOptionalString(clawpack.npmTarballName);
  return {
    artifactKind: "npm-pack",
    artifactFormat: "tgz",
    ...(npmIntegrity ? { npmIntegrity } : {}),
    ...(npmShasum ? { npmShasum } : {}),
    ...(npmTarballName ? { npmTarballName } : {}),
    ...(clawpackSha256 ? { clawpackSha256 } : {}),
    ...(clawpackSpecVersion !== undefined ? { clawpackSpecVersion } : {}),
    ...(clawpackManifestSha256 ? { clawpackManifestSha256 } : {}),
    ...(clawpackSize !== undefined ? { clawpackSize } : {}),
  };
}

/** Builds plugin install record fields from resolved ClawHub package metadata. */
export function buildClawHubPluginInstallRecordFields(
  fields: ClawHubPluginInstallRecordFields,
): Pick<PluginInstallRecord, keyof ClawHubPluginInstallRecordFields> {
  return {
    source: "clawhub",
    clawhubUrl: fields.clawhubUrl,
    clawhubPackage: fields.clawhubPackage,
    clawhubFamily: fields.clawhubFamily,
    ...(fields.clawhubChannel ? { clawhubChannel: fields.clawhubChannel } : {}),
    ...(fields.clawhubTrustDisposition
      ? { clawhubTrustDisposition: fields.clawhubTrustDisposition }
      : {}),
    ...(fields.clawhubTrustScanStatus
      ? { clawhubTrustScanStatus: fields.clawhubTrustScanStatus }
      : {}),
    ...(fields.clawhubTrustModerationState
      ? { clawhubTrustModerationState: fields.clawhubTrustModerationState }
      : {}),
    ...(fields.clawhubTrustReasons ? { clawhubTrustReasons: fields.clawhubTrustReasons } : {}),
    ...(fields.clawhubTrustPending !== undefined
      ? { clawhubTrustPending: fields.clawhubTrustPending }
      : {}),
    ...(fields.clawhubTrustStale !== undefined
      ? { clawhubTrustStale: fields.clawhubTrustStale }
      : {}),
    ...(fields.clawhubTrustCheckedAt
      ? { clawhubTrustCheckedAt: fields.clawhubTrustCheckedAt }
      : {}),
    ...(fields.clawhubTrustAcknowledgedAt
      ? { clawhubTrustAcknowledgedAt: fields.clawhubTrustAcknowledgedAt }
      : {}),
    ...(fields.version ? { version: fields.version } : {}),
    ...(fields.integrity ? { integrity: fields.integrity } : {}),
    ...(fields.resolvedAt ? { resolvedAt: fields.resolvedAt } : {}),
    ...(fields.installedAt ? { installedAt: fields.installedAt } : {}),
    ...(fields.artifactKind ? { artifactKind: fields.artifactKind } : {}),
    ...(fields.artifactFormat ? { artifactFormat: fields.artifactFormat } : {}),
    ...(fields.npmIntegrity ? { npmIntegrity: fields.npmIntegrity } : {}),
    ...(fields.npmShasum ? { npmShasum: fields.npmShasum } : {}),
    ...(fields.npmTarballName ? { npmTarballName: fields.npmTarballName } : {}),
    ...(fields.clawpackSha256 ? { clawpackSha256: fields.clawpackSha256 } : {}),
    ...(fields.clawpackSpecVersion !== undefined
      ? { clawpackSpecVersion: fields.clawpackSpecVersion }
      : {}),
    ...(fields.clawpackManifestSha256
      ? { clawpackManifestSha256: fields.clawpackManifestSha256 }
      : {}),
    ...(fields.clawpackSize !== undefined ? { clawpackSize: fields.clawpackSize } : {}),
  };
}
