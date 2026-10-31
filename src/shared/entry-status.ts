import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isOsRequirementSatisfied,
  type Requirements,
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
  const { always, hasLocalBin, isEnvSatisfied, isConfigSatisfied, remote } = params;
  const localPlatform = params.platform ?? process.platform;
  const required: Requirements = {
    bins: metadata?.requires?.bins ?? [],
    anyBins: metadata?.requires?.anyBins ?? [],
    env: metadata?.requires?.env ?? [],
    config: metadata?.requires?.config ?? [],
    os: metadata?.os ?? [],
  };

  const hasRemoteBin = remote?.hasBin;
  const hasRemoteAnyBin = remote?.hasAnyBin;
  const missingBins = required.bins.filter((bin) => !hasLocalBin(bin) && !hasRemoteBin?.(bin));
  const missingAnyBins =
    required.anyBins.length === 0 ||
    required.anyBins.some((bin) => hasLocalBin(bin)) ||
    hasRemoteAnyBin?.(required.anyBins)
      ? []
      : required.anyBins;

  const missingOs = isOsRequirementSatisfied(required.os, [
    localPlatform,
    ...(remote?.platforms ?? []),
  ])
    ? []
    : required.os;

  const missingEnv = required.env.filter((envName) => !isEnvSatisfied(envName));
  const configChecks = required.config.map((path) => ({
    path,
    satisfied: isConfigSatisfied(path),
  }));
  const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);

  // `always` bypasses runtime requirements, but OS remains a hard compatibility boundary.
  const missing = {
    bins: always ? [] : missingBins,
    anyBins: always ? [] : missingAnyBins,
    env: always ? [] : missingEnv,
    config: always ? [] : missingConfig,
    os: missingOs,
  };

  const eligible = Object.values(missing).every((requirements) => requirements.length === 0);
  return {
    ...(emoji ? { emoji } : {}),
    ...(homepage ? { homepage } : {}),
    required,
    missing,
    requirementsSatisfied: eligible,
    configChecks,
  };
}
