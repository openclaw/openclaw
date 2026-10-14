import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  evaluateRequirementsFromMetadataWithRemote,
  type RequirementRemote,
  type RequirementsMetadata,
} from "./requirements.js";

/** Evaluates skill and hook presentation metadata and requirements on the current platform. */
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
  platform?: string;
  remote?: RequirementRemote;
  isEnvSatisfied: (envName: string) => boolean;
  isConfigSatisfied: (pathStr: string) => boolean;
}) {
  const { metadata, frontmatter } = params.entry;
  const emoji = metadata?.emoji ?? frontmatter?.emoji;
  // Explicit blank values suppress lower-priority aliases; normalize only after selection.
  const homepage = normalizeOptionalString(
    metadata?.homepage ?? frontmatter?.homepage ?? frontmatter?.website ?? frontmatter?.url,
  );
  const { required, missing, eligible, configChecks } = evaluateRequirementsFromMetadataWithRemote({
    ...params,
    metadata: metadata ?? undefined,
    localPlatform: params.platform ?? process.platform,
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
