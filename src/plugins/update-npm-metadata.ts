import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseRegistryNpmSpec, type NpmSpecResolution } from "../infra/npm-registry-spec.js";
import { resolveCompatibilityHostVersion } from "../version.js";
import { resolveTrustedOfficialPrereleaseResolution } from "./install-npm-metadata.js";
import { validateOpenClawPackageInstallCompatibility } from "./package-compat.js";
import {
  expectedIntegrityForNpmUpdate,
  shouldBypassTrustedOfficialUnchangedNpmCheck,
} from "./update-source.js";

/** Prepare one attempt's initial registry facts without replacing installer validation. */
export async function prepareNpmPluginUpdateMetadata(params: {
  spec: string;
  metadata: NpmSpecResolution;
  record: PluginInstallRecord;
  trustedSourceLinkedOfficialInstall: boolean;
  catalogExpectedIntegrity?: string;
  timeoutMs?: number;
}) {
  const bypassUnchanged = shouldBypassTrustedOfficialUnchangedNpmCheck(params);
  const parsedSpec = bypassUnchanged ? parseRegistryNpmSpec(params.spec) : null;
  const trustedPrereleaseResolution =
    parsedSpec && params.metadata.version
      ? await resolveTrustedOfficialPrereleaseResolution({
          spec: parsedSpec,
          resolvedPrereleaseVersion: params.metadata.version,
          timeoutMs: params.timeoutMs,
        })
      : null;
  const expectedIntegrityMetadata =
    trustedPrereleaseResolution && trustedPrereleaseResolution.kind !== "allow-prerelease-only"
      ? trustedPrereleaseResolution.resolution
      : params.metadata;
  let expectedIntegrity =
    params.catalogExpectedIntegrity ??
    expectedIntegrityForNpmUpdate({
      effectiveSpec: params.spec,
      metadata: expectedIntegrityMetadata,
      record: params.record,
      trustedSourceLinkedOfficialInstall: params.trustedSourceLinkedOfficialInstall,
    });
  const currentHostVersion = resolveCompatibilityHostVersion();
  if (
    !params.catalogExpectedIntegrity &&
    (validateOpenClawPackageInstallCompatibility({
      currentHostVersion,
      pluginId: expectedIntegrityMetadata.name ?? params.spec,
      packageMetadata: expectedIntegrityMetadata.packageOpenClaw,
    }) !== null ||
      (bypassUnchanged && !trustedPrereleaseResolution))
  ) {
    expectedIntegrity = undefined;
  }
  return {
    npmMetadata: {
      spec: params.spec,
      metadata: params.metadata,
      ...(trustedPrereleaseResolution ? { trustedPrereleaseResolution } : {}),
    },
    expectedIntegrity,
    unchangedEligible:
      !bypassUnchanged &&
      validateOpenClawPackageInstallCompatibility({
        currentHostVersion,
        pluginId: params.metadata.name ?? params.spec,
        packageMetadata: params.metadata.packageOpenClaw,
      }) === null,
  };
}
