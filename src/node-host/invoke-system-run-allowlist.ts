import {
  analyzeArgvCommand,
  evaluateDenylist,
  evaluateExecAllowlist,
  evaluateShellAllowlist,
  resolvePlannedSegmentArgv,
  resolveExecApprovals,
  type ExecAllowlistEntry,
  type ExecCommandSegment,
  type ExecSecurity,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import type { RunResult } from "./invoke-types.js";

export class DenylistError extends Error {
  constructor(
    public readonly pattern: string,
    public readonly reason: string | undefined,
  ) {
    super(
      reason
        ? `Command blocked by exec denylist: ${pattern} (${reason})`
        : `Command blocked by exec denylist: ${pattern}`,
    );
  }
}

export type SystemRunAllowlistAnalysis = {
  analysisOk: boolean;
  allowlistMatches: ExecAllowlistEntry[];
  allowlistSatisfied: boolean;
  segments: ExecCommandSegment[];
  segmentAllowlistEntries: Array<ExecAllowlistEntry | null>;
  deniedByDenylist?: boolean;
  denylistMatch?: { pattern: string; reason?: string } | null;
};

export function evaluateSystemRunAllowlist(params: {
  shellCommand: string | null;
  argv: string[];
  approvals: ReturnType<typeof resolveExecApprovals>;
  security: ExecSecurity;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
}): SystemRunAllowlistAnalysis {
  if (params.shellCommand) {
    const allowlistEval = evaluateShellAllowlist({
      command: params.shellCommand,
      allowlist: params.approvals.allowlist,
      denylist: params.approvals.denylist,
      safeBins: params.safeBins,
      safeBinProfiles: params.safeBinProfiles,
      cwd: params.cwd,
      env: params.env,
      trustedSafeBinDirs: params.trustedSafeBinDirs,
      skillBins: params.skillBins,
      autoAllowSkills: params.autoAllowSkills,
      platform: process.platform,
    });
    // Denylist takes precedence: block immediately regardless of security mode
    if (allowlistEval.deniedByDenylist && allowlistEval.denylistMatch) {
      throw new DenylistError(
        allowlistEval.denylistMatch.pattern,
        allowlistEval.denylistMatch.reason,
      );
    }
    return {
      analysisOk: allowlistEval.analysisOk,
      allowlistMatches: allowlistEval.allowlistMatches,
      allowlistSatisfied:
        params.security === "allowlist" && allowlistEval.analysisOk
          ? allowlistEval.allowlistSatisfied
          : false,
      segments: allowlistEval.segments,
      segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
      deniedByDenylist: allowlistEval.deniedByDenylist,
      denylistMatch: allowlistEval.denylistMatch,
    };
  }

  const analysis = analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });

  // Denylist check for argv commands
  const denylistEntry = evaluateDenylist({
    segments: analysis.segments,
    denylist: params.approvals.denylist,
  });
  if (denylistEntry) {
    throw new DenylistError(denylistEntry.pattern, denylistEntry.reason);
  }

  const allowlistEval = evaluateExecAllowlist({
    analysis,
    allowlist: params.approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  });
  return {
    analysisOk: analysis.ok,
    allowlistMatches: allowlistEval.allowlistMatches,
    allowlistSatisfied:
      params.security === "allowlist" && analysis.ok ? allowlistEval.allowlistSatisfied : false,
    segments: analysis.segments,
    segmentAllowlistEntries: allowlistEval.segmentAllowlistEntries,
  };
}

export function resolvePlannedAllowlistArgv(params: {
  security: ExecSecurity;
  shellCommand: string | null;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  segments: ExecCommandSegment[];
}): string[] | undefined | null {
  if (
    params.security !== "allowlist" ||
    params.policy.approvedByAsk ||
    params.shellCommand ||
    !params.policy.analysisOk ||
    !params.policy.allowlistSatisfied ||
    params.segments.length !== 1
  ) {
    return undefined;
  }
  const plannedAllowlistArgv = resolvePlannedSegmentArgv(params.segments[0]);
  return plannedAllowlistArgv && plannedAllowlistArgv.length > 0 ? plannedAllowlistArgv : null;
}

export function resolveSystemRunExecArgv(params: {
  plannedAllowlistArgv: string[] | undefined;
  argv: string[];
  security: ExecSecurity;
  isWindows: boolean;
  policy: {
    approvedByAsk: boolean;
    analysisOk: boolean;
    allowlistSatisfied: boolean;
  };
  shellCommand: string | null;
  segments: ExecCommandSegment[];
}): string[] {
  let execArgv = params.plannedAllowlistArgv ?? params.argv;
  if (
    params.security === "allowlist" &&
    params.isWindows &&
    !params.policy.approvedByAsk &&
    params.shellCommand &&
    params.policy.analysisOk &&
    params.policy.allowlistSatisfied &&
    params.segments.length === 1 &&
    params.segments[0]?.argv.length > 0
  ) {
    execArgv = params.segments[0].argv;
  }
  return execArgv;
}

export function applyOutputTruncation(result: RunResult): void {
  if (!result.truncated) {
    return;
  }
  const suffix = "... (truncated)";
  if (result.stderr.trim().length > 0) {
    result.stderr = `${result.stderr}\n${suffix}`;
  } else {
    result.stdout = `${result.stdout}\n${suffix}`;
  }
}