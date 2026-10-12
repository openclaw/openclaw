import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { ClawHubPackageChannel, ClawHubPackageFamily } from "../infra/clawhub-packages.js";
import { omitUndefinedManifestFields } from "./manifest-capability-normalizers.js";

/** Install record fields captured for ClawHub plugin installs. */
export type ClawHubPluginInstallRecordFields = {
  source: "clawhub";
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: Exclude<ClawHubPackageFamily, "skill">;
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

/** Builds plugin install record fields from resolved ClawHub package metadata. */
export function buildClawHubPluginInstallRecordFields(
  fields: ClawHubPluginInstallRecordFields,
): Pick<PluginInstallRecord, keyof ClawHubPluginInstallRecordFields> {
  return {
    source: "clawhub",
    clawhubUrl: fields.clawhubUrl,
    clawhubPackage: fields.clawhubPackage,
    clawhubFamily: fields.clawhubFamily,
    ...omitUndefinedManifestFields({
      clawhubChannel: fields.clawhubChannel || undefined,
      clawhubTrustDisposition: fields.clawhubTrustDisposition || undefined,
      clawhubTrustScanStatus: fields.clawhubTrustScanStatus || undefined,
      clawhubTrustModerationState: fields.clawhubTrustModerationState || undefined,
      clawhubTrustReasons: fields.clawhubTrustReasons || undefined,
      clawhubTrustPending: fields.clawhubTrustPending,
      clawhubTrustStale: fields.clawhubTrustStale,
      clawhubTrustCheckedAt: fields.clawhubTrustCheckedAt || undefined,
      clawhubTrustAcknowledgedAt: fields.clawhubTrustAcknowledgedAt || undefined,
      version: fields.version || undefined,
      integrity: fields.integrity || undefined,
      resolvedAt: fields.resolvedAt || undefined,
      installedAt: fields.installedAt || undefined,
      artifactKind: fields.artifactKind || undefined,
      artifactFormat: fields.artifactFormat || undefined,
      npmIntegrity: fields.npmIntegrity || undefined,
      npmShasum: fields.npmShasum || undefined,
      npmTarballName: fields.npmTarballName || undefined,
      clawpackSha256: fields.clawpackSha256 || undefined,
      clawpackSpecVersion: fields.clawpackSpecVersion,
      clawpackManifestSha256: fields.clawpackManifestSha256 || undefined,
      clawpackSize: fields.clawpackSize,
    }),
  };
}
