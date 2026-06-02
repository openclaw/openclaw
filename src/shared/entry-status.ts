import { resolveEmojiAndHomepage } from "./entry-metadata.js";
import {
  evaluateRequirementsFromMetadataWithRemote,
  type RequirementConfigCheck,
  type RequirementRemote,
  type Requirements,
  type RequirementsMetadata,
} from "./requirements.js";

/** Parameters accepted by entry requirement evaluators after local platform is selected. */
export type EntryMetadataRequirementsParams = Parameters<
  typeof evaluateEntryMetadataRequirements
>[0];

/** Resolves entry presentation metadata and requirement eligibility in one shared shape. */
export function evaluateEntryMetadataRequirements(params: {
  /** When true, keep diagnostics but treat the entry as requirement-satisfied. */
  always: boolean;
  /** Canonical metadata block from skill/hook manifests. */
  metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
  /** Frontmatter fallback metadata from older skill/hook files. */
  frontmatter?: {
    emoji?: string;
    homepage?: string;
    website?: string;
    url?: string;
  } | null;
  /** Local binary availability checker. */
  hasLocalBin: (bin: string) => boolean;
  /** Local Node platform id used for OS requirements. */
  localPlatform: string;
  /** Optional remote capability checks that can satisfy bin/platform requirements. */
  remote?: RequirementRemote;
  /** Environment requirement checker owned by the caller. */
  isEnvSatisfied: (envName: string) => boolean;
  /** Config requirement checker owned by the caller. */
  isConfigSatisfied: (pathStr: string) => boolean;
}): {
  /** Resolved display emoji, if metadata or frontmatter supplied one. */
  emoji?: string;
  /** Resolved homepage URL, if metadata or frontmatter supplied one. */
  homepage?: string;
  /** Canonical requirement lists read from metadata. */
  required: Requirements;
  /** Requirement lists still unsatisfied after local/remote evaluation. */
  missing: Requirements;
  /** True when the entry can run under the supplied requirement checks. */
  requirementsSatisfied: boolean;
  /** Per-config-path diagnostics preserved for UI/status output. */
  configChecks: RequirementConfigCheck[];
} {
  const { emoji, homepage } = resolveEmojiAndHomepage({
    metadata: params.metadata,
    frontmatter: params.frontmatter,
  });
  const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
    always: params.always,
    metadata: params.metadata ?? undefined,
    hasLocalBin: params.hasLocalBin,
    localPlatform: params.localPlatform,
    remote: params.remote,
    isEnvSatisfied: params.isEnvSatisfied,
    isConfigSatisfied: params.isConfigSatisfied,
  });
  return {
    ...(emoji ? { emoji } : {}),
    ...(homepage ? { homepage } : {}),
    required,
    missing,
    requirementsSatisfied: eligible,
    configChecks,
  };
}

/** Evaluates entry metadata requirements against the current Node platform. */
export function evaluateEntryMetadataRequirementsForCurrentPlatform(
  params: Omit<EntryMetadataRequirementsParams, "localPlatform">,
): ReturnType<typeof evaluateEntryMetadataRequirements> {
  return evaluateEntryMetadataRequirements({
    ...params,
    localPlatform: process.platform,
  });
}

/** Evaluates an entry object's metadata/frontmatter requirements on the current platform. */
export function evaluateEntryRequirementsForCurrentPlatform(params: {
  always: boolean;
  entry: {
    metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
    frontmatter?: {
      emoji?: string;
      homepage?: string;
      website?: string;
      url?: string;
    } | null;
  };
  hasLocalBin: (bin: string) => boolean;
  remote?: RequirementRemote;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}): ReturnType<typeof evaluateEntryMetadataRequirements> {
  return evaluateEntryMetadataRequirementsForCurrentPlatform({
    always: params.always,
    metadata: params.entry.metadata,
    frontmatter: params.entry.frontmatter,
    hasLocalBin: params.hasLocalBin,
    remote: params.remote,
    isEnvSatisfied: params.isEnvSatisfied,
    isConfigSatisfied: params.isConfigSatisfied,
  });
}
