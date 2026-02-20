import {
  DEFAULT_SAFE_BINS,
  analyzeShellCommand,
  isWindowsPlatform,
  matchAllowlist,
  resolveAllowlistCandidatePath,
  splitCommandChain,
  type ExecCommandAnalysis,
  type CommandResolution,
  type ExecCommandSegment,
} from "./exec-approvals-analysis.js";
import type { ExecAllowlistEntry } from "./exec-approvals.js";
import {
  SAFE_BIN_GENERIC_PROFILE,
  SAFE_BIN_PROFILES,
  type SafeBinProfile,
  validateSafeBinArgv,
} from "./exec-safe-bin-policy.js";
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";

export function normalizeSafeBins(entries?: string[]): Set<string> {
  if (!Array.isArray(entries)) {
    return new Set();
  }
  const normalized = entries
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  return new Set(normalized);
}

export function resolveSafeBins(entries?: string[] | null): Set<string> {
  if (entries === undefined) {
    return normalizeSafeBins(DEFAULT_SAFE_BINS);
  }
  return normalizeSafeBins(entries ?? []);
}

export function isSafeBinUsage(params: {
  argv: string[];
  resolution: CommandResolution | null;
  safeBins: Set<string>;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  safeBinProfiles?: Readonly<Record<string, SafeBinProfile>>;
  safeBinGenericProfile?: SafeBinProfile;
  isTrustedSafeBinPathFn?: typeof isTrustedSafeBinPath;
}): boolean {
  // Windows host exec uses PowerShell, which has different parsing/expansion rules.
  // Keep safeBins conservative there (require explicit allowlist entries).
  if (isWindowsPlatform(params.platform ?? process.platform)) {
    return false;
  }
  if (params.safeBins.size === 0) {
    return false;
  }
  const resolution = params.resolution;
  const execName = resolution?.executableName?.toLowerCase();
  if (!execName) {
    return false;
  }
  const matchesSafeBin = params.safeBins.has(execName);
  if (!matchesSafeBin) {
    return false;
  }
  if (!resolution?.resolvedPath) {
    return false;
  }
  const isTrustedPath = params.isTrustedSafeBinPathFn ?? isTrustedSafeBinPath;
  if (
    !isTrustedPath({
      resolvedPath: resolution.resolvedPath,
      trustedDirs: params.trustedSafeBinDirs,
    })
  ) {
    return false;
  }
  const argv = params.argv.slice(1);
  const safeBinProfiles = params.safeBinProfiles ?? SAFE_BIN_PROFILES;
  const genericSafeBinProfile = params.safeBinGenericProfile ?? SAFE_BIN_GENERIC_PROFILE;
  const profile = safeBinProfiles[execName] ?? genericSafeBinProfile;
  return validateSafeBinArgv(argv, profile);
}

export type ExecAllowlistEvaluation = {
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

export type ExecSegmentSatisfiedBy = "allowlist" | "safeBins" | "skills" | null;

function evaluateSegments(
  segments: ExecCommandSegment[],
  params: {
    allowlist: ExecAllowlistEntry[];
    safeBins: Set<string>;
    cwd?: string;
    platform?: string | null;
    trustedSafeBinDirs?: ReadonlySet<string>;
    skillBins?: Set<string>;
    autoAllowSkills?: boolean;
  },
): {
  satisfied: boolean;
  matches: ExecAllowlistEntry[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
} {
  const matches: ExecAllowlistEntry[] = [];
  const allowSkills = params.autoAllowSkills === true && (params.skillBins?.size ?? 0) > 0;
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  const satisfied = segments.every((segment) => {
    const candidatePath = resolveAllowlistCandidatePath(segment.resolution, params.cwd);
    const candidateResolution =
      candidatePath && segment.resolution
        ? { ...segment.resolution, resolvedPath: candidatePath }
        : segment.resolution;
    const match = matchAllowlist(params.allowlist, candidateResolution);
    if (match) {
      matches.push(match);
    }
    const safe = isSafeBinUsage({
      argv: segment.argv,
      resolution: segment.resolution,
      safeBins: params.safeBins,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
    });
    const skillAllow =
      allowSkills && segment.resolution?.executableName
        ? params.skillBins?.has(segment.resolution.executableName)
        : false;
    const by: ExecSegmentSatisfiedBy = match
      ? "allowlist"
      : safe
        ? "safeBins"
        : skillAllow
          ? "skills"
          : null;
    segmentSatisfiedBy.push(by);
    return Boolean(by);
  });

  return { satisfied, matches, segmentSatisfiedBy };
}

export function evaluateExecAllowlist(params: {
  analysis: ExecCommandAnalysis;
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  cwd?: string;
  platform?: string | null;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: Set<string>;
  autoAllowSkills?: boolean;
}): ExecAllowlistEvaluation {
  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];
  if (!params.analysis.ok || params.analysis.segments.length === 0) {
    return { allowlistSatisfied: false, allowlistMatches, segmentSatisfiedBy };
  }

  // If the analysis contains chains, evaluate each chain part separately
  if (params.analysis.chains) {
    for (const chainSegments of params.analysis.chains) {
      const result = evaluateSegments(chainSegments, {
        allowlist: params.allowlist,
        safeBins: params.safeBins,
        cwd: params.cwd,
        platform: params.platform,
        trustedSafeBinDirs: params.trustedSafeBinDirs,
        skillBins: params.skillBins,
        autoAllowSkills: params.autoAllowSkills,
      });
      if (!result.satisfied) {
        return { allowlistSatisfied: false, allowlistMatches: [], segmentSatisfiedBy: [] };
      }
      allowlistMatches.push(...result.matches);
      segmentSatisfiedBy.push(...result.segmentSatisfiedBy);
    }
    return { allowlistSatisfied: true, allowlistMatches, segmentSatisfiedBy };
  }

  // No chains, evaluate all segments together
  const result = evaluateSegments(params.analysis.segments, {
    allowlist: params.allowlist,
    safeBins: params.safeBins,
    cwd: params.cwd,
    platform: params.platform,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  });
  return {
    allowlistSatisfied: result.satisfied,
    allowlistMatches: result.matches,
    segmentSatisfiedBy: result.segmentSatisfiedBy,
  };
}

export type ExecAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistSatisfied: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  segments: ExecCommandSegment[];
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
};

/**
 * Evaluates allowlist for shell commands (including &&, ||, ;) and returns analysis metadata.
 */
export function evaluateShellAllowlist(params: {
  command: string;
  allowlist: ExecAllowlistEntry[];
  safeBins: Set<string>;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  trustedSafeBinDirs?: ReadonlySet<string>;
  skillBins?: Set<string>;
  autoAllowSkills?: boolean;
  platform?: string | null;
}): ExecAllowlistAnalysis {
  const analysisFailure = (): ExecAllowlistAnalysis => ({
    analysisOk: false,
    allowlistSatisfied: false,
    allowlistMatches: [],
    segments: [],
    segmentSatisfiedBy: [],
  });

  const chainParts = isWindowsPlatform(params.platform) ? null : splitCommandChain(params.command);
  if (!chainParts) {
    const analysis = analyzeShellCommand({
      command: params.command,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!analysis.ok) {
      return analysisFailure();
    }
    const evaluation = evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      cwd: params.cwd,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });
    return {
      analysisOk: true,
      allowlistSatisfied: evaluation.allowlistSatisfied,
      allowlistMatches: evaluation.allowlistMatches,
      segments: analysis.segments,
      segmentSatisfiedBy: evaluation.segmentSatisfiedBy,
    };
  }

  const allowlistMatches: ExecAllowlistEntry[] = [];
  const segments: ExecCommandSegment[] = [];
  const segmentSatisfiedBy: ExecSegmentSatisfiedBy[] = [];

  for (const part of chainParts) {
    const analysis = analyzeShellCommand({
      command: part,
      cwd: params.cwd,
      env: params.env,
      platform: params.platform,
    });
    if (!analysis.ok) {
      return analysisFailure();
    }

    segments.push(...analysis.segments);
    const evaluation = evaluateExecAllowlist({
      analysis,
      allowlist: params.allowlist,
      safeBins: params.safeBins,
      cwd: params.cwd,
      platform: params.platform,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
    });
    allowlistMatches.push(...evaluation.allowlistMatches);
    segmentSatisfiedBy.push(...evaluation.segmentSatisfiedBy);
    if (!evaluation.allowlistSatisfied) {
      return {
        analysisOk: true,
        allowlistSatisfied: false,
        allowlistMatches,
        segments,
        segmentSatisfiedBy,
      };
    }
  }

  return {
    analysisOk: true,
    allowlistSatisfied: true,
    allowlistMatches,
    segments,
    segmentSatisfiedBy,
  };
}
