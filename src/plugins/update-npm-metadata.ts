import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { resolveTrustedOfficialPrereleaseResolution } from "./install-npm-metadata.js";
import {
  expectedIntegrityForNpmUpdate,
  isNpmMetadataCompatibleWithCurrentHost,
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
  if (
    !params.catalogExpectedIntegrity &&
    (!isNpmMetadataCompatibleWithCurrentHost(expectedIntegrityMetadata) ||
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
    unchangedEligible: !bypassUnchanged && isNpmMetadataCompatibleWithCurrentHost(params.metadata),
  };
}
