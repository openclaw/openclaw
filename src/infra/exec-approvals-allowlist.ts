import path from "node:path";
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
import { isTrustedSafeBinPath } from "./exec-safe-bin-trust.js";

function isPathLikeToken(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed === "-") {
    return false;
  }
  if (trimmed.startsWith("./") || trimmed.startsWith("../") || trimmed.startsWith("~")) {
    return true;
  }
  if (trimmed.startsWith("/")) {
    return true;
  }
  return /^[A-Za-z]:[\\/]/.test(trimmed);
}

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

function hasGlobToken(value: string): boolean {
  // Safe bins are stdin-only; globbing is both surprising and a historical bypass vector.
  // Note: we still harden execution-time expansion separately.
  return /[*?[\]]/.test(value);
}

type SafeBinProfile = {
  minPositional?: number;
  maxPositional?: number;
  valueFlags?: ReadonlySet<string>;
  blockedFlags?: ReadonlySet<string>;
};

const NO_FLAGS = new Set<string>();
const SAFE_BIN_GENERIC_PROFILE: SafeBinProfile = {};
const SAFE_BIN_PROFILES: Record<string, SafeBinProfile> = {
  jq: {
    maxPositional: 1,
    valueFlags: new Set([
      "--arg",
      "--argjson",
      "--argstr",
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ]),
    blockedFlags: new Set([
      "--argfile",
      "--rawfile",
      "--slurpfile",
      "--from-file",
      "--library-path",
      "-L",
      "-f",
    ]),
  },
  grep: {
    maxPositional: 1,
    valueFlags: new Set([
      "--regexp",
      "--file",
      "--max-count",
      "--after-context",
      "--before-context",
      "--context",
      "--devices",
      "--directories",
      "--binary-files",
      "--exclude",
      "--exclude-from",
      "--include",
      "--label",
      "-e",
      "-f",
      "-m",
      "-A",
      "-B",
      "-C",
      "-D",
      "-d",
    ]),
    blockedFlags: new Set([
      "--file",
      "--exclude-from",
      "--dereference-recursive",
      "--directories",
      "--recursive",
      "-f",
      "-d",
      "-r",
      "-R",
    ]),
  },
  cut: {
    maxPositional: 0,
    valueFlags: new Set([
      "--bytes",
      "--characters",
      "--fields",
      "--delimiter",
      "--output-delimiter",
      "-b",
      "-c",
      "-f",
      "-d",
    ]),
  },
  sort: {
    maxPositional: 0,
    valueFlags: new Set([
      "--key",
      "--field-separator",
      "--buffer-size",
      "--temporary-directory",
      "--compress-program",
      "--parallel",
      "--batch-size",
      "--random-source",
      "--files0-from",
      "--output",
      "-k",
      "-t",
      "-S",
      "-T",
      "-o",
    ]),
    blockedFlags: new Set(["--files0-from", "--output", "-o"]),
  },
  uniq: {
    maxPositional: 0,
    valueFlags: new Set([
      "--skip-fields",
      "--skip-chars",
      "--check-chars",
      "--group",
      "-f",
      "-s",
      "-w",
    ]),
  },
  head: {
    maxPositional: 0,
    valueFlags: new Set(["--lines", "--bytes", "-n", "-c"]),
  },
  tail: {
    maxPositional: 0,
    valueFlags: new Set([
      "--lines",
      "--bytes",
      "--sleep-interval",
      "--max-unchanged-stats",
      "--pid",
      "-n",
      "-c",
    ]),
  },
  tr: {
    minPositional: 1,
    maxPositional: 2,
  },
  wc: {
    maxPositional: 0,
    valueFlags: new Set(["--files0-from"]),
    blockedFlags: new Set(["--files0-from"]),
  },
};

function isSafeLiteralToken(value: string): boolean {
  if (!value || value === "-") {
    return true;
  }
  return !hasGlobToken(value) && !isPathLikeToken(value);
}

function validateSafeBinArgv(args: string[], profile: SafeBinProfile): boolean {
  const valueFlags = profile.valueFlags ?? NO_FLAGS;
  const blockedFlags = profile.blockedFlags ?? NO_FLAGS;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token) {
      continue;
    }
    if (token === "--") {
      for (let j = i + 1; j < args.length; j += 1) {
        const rest = args[j];
        if (!rest || rest === "-") {
          continue;
        }
        if (!isSafeLiteralToken(rest)) {
          return false;
        }
        positional.push(rest);
      }
      break;
    }
    if (token === "-") {
      continue;
    }
    if (!token.startsWith("-")) {
      if (!isSafeLiteralToken(token)) {
        return false;
      }
      positional.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      const eqIndex = token.indexOf("=");
      const flag = eqIndex > 0 ? token.slice(0, eqIndex) : token;
      if (blockedFlags.has(flag)) {
        return false;
      }
      if (eqIndex > 0) {
        if (!isSafeLiteralToken(token.slice(eqIndex + 1))) {
          return false;
        }
        continue;
      }
      if (!valueFlags.has(flag)) {
        continue;
      }
      const value = args[i + 1];
      if (!value || !isSafeLiteralToken(value)) {
        return false;
      }
      i += 1;
      continue;
    }

    let consumedValue = false;
    for (let j = 1; j < token.length; j += 1) {
      const flag = `-${token[j]}`;
      if (blockedFlags.has(flag)) {
        return false;
      }
      if (!valueFlags.has(flag)) {
        continue;
      }
      const inlineValue = token.slice(j + 1);
      if (inlineValue) {
        if (!isSafeLiteralToken(inlineValue)) {
          return false;
        }
      } else {
        const value = args[i + 1];
        if (!value || !isSafeLiteralToken(value)) {
          return false;
        }
        i += 1;
      }
      consumedValue = true;
      break;
    }
    if (!consumedValue && hasGlobToken(token)) {
      return false;
    }
  }

  const minPositional = profile.minPositional ?? 0;
  if (positional.length < minPositional) {
    return false;
  }
  if (typeof profile.maxPositional === "number" && positional.length > profile.maxPositional) {
    return false;
  }
  return true;
}
export function isSafeBinUsage(params: {
  argv: string[];
  resolution: CommandResolution | null;
  safeBins: Set<string>;
  cwd?: string;
  fileExists?: (filePath: string) => boolean;
  trustedSafeBinDirs?: ReadonlySet<string>;
}): boolean {
  // Windows host exec uses PowerShell, which has different parsing/expansion rules.
  // Keep safeBins conservative there (require explicit allowlist entries).
  if (isWindowsPlatform(process.platform)) {
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
  const matchesSafeBin =
    params.safeBins.has(execName) ||
    (process.platform === "win32" && params.safeBins.has(path.parse(execName).name));
  if (!matchesSafeBin) {
    return false;
  }
  if (!resolution?.resolvedPath) {
    return false;
  }
  if (
    !isTrustedSafeBinPath({
      resolvedPath: resolution.resolvedPath,
      trustedDirs: params.trustedSafeBinDirs,
    })
  ) {
    return false;
  }
  const argv = params.argv.slice(1);
  const profile = SAFE_BIN_PROFILES[execName] ?? SAFE_BIN_GENERIC_PROFILE;
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
      cwd: params.cwd,
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
