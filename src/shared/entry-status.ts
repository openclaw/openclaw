import { resolveEmojiAndHomepage } from "./entry-metadata.js";
import {
  evaluateRequirementsFromMetadataWithRemote,
  type RequirementConfigCheck,
  type Requirements,
  type RequirementsMetadata,
} from "./requirements.js";

export function evaluateEntryMetadataRequirements(params: {
  always: boolean;
  metadata?: (RequirementsMetadata & { emoji?: string; homepage?: string }) | null;
  frontmatter?: {
    emoji?: string;
    homepage?: string;
    website?: string;
    url?: string;
  } | null;
  hasLocalBin: (bin: string) => boolean;
  localPlatform: string;
  remote?: {
    hasBin?: (bin: string) => boolean;
    hasAnyBin?: (bins: string[]) => boolean;
    platforms?: string[];
  };
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}): {
  emoji?: string;
  homepage?: string;
  required: Requirements;
  missing: Requirements;
  requirementsSatisfied: boolean;
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
