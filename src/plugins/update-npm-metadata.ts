import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { NpmSpecResolution } from "../infra/install-source-utils.js";
import {
  expectedIntegrityForNpmUpdate,
  isNpmMetadataCompatibleWithCurrentHost,
  resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate,
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
  const trustedPrereleaseFallback = params.trustedSourceLinkedOfficialInstall
    ? await resolveTrustedOfficialPrereleaseFallbackMetadataForUpdate(params)
    : undefined;
  const expectedIntegrityMetadata = trustedPrereleaseFallback?.metadata ?? params.metadata;
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
      (bypassUnchanged && !trustedPrereleaseFallback))
  ) {
    expectedIntegrity = undefined;
  }
  return {
    npmMetadata: { spec: params.spec, metadata: params.metadata },
    expectedIntegrity,
    unchangedEligible: !bypassUnchanged && isNpmMetadataCompatibleWithCurrentHost(params.metadata),
  };
}
