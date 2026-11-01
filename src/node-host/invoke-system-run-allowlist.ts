import { expectDefined } from "@openclaw/normalization-core";
import {
  analyzeArgvCommand,
  evaluateExecAllowlist,
  evaluateShellAllowlistWithAuthorization,
  resolvePlannedSegmentArgv,
  type ExecAllowlistAnalysis,
  type ExecApprovalsResolved,
  type ExecCommandSegment,
  type ExecSegmentSatisfiedBy,
  type ExecSecurity,
  type SkillBinTrustEntry,
} from "../infra/exec-approvals.js";
import type { ExecAuthorizationPlan } from "../infra/exec-authorization-plan.js";
import { buildAuthorizedShellCommandFromPlan } from "../infra/exec-authorization-render.js";
import { resolveExecSafeBinRuntimePolicy } from "../infra/exec-safe-bin-runtime-policy.js";
import {
  normalizeExecutableToken,
  POSIX_PARSEABLE_SHELL_WRAPPERS,
  POSIX_SHELL_WRAPPERS,
  resolveShellWrapperTransportArgv,
} from "../infra/exec-wrapper-resolution.js";
import {
  POSIX_INLINE_COMMAND_FLAGS,
  resolveInlineCommandMatch,
} from "../infra/shell-inline-command.js";
import type { RunResult } from "./invoke-types.js";

type SystemRunAllowlistAnalysis = ExecAllowlistAnalysis & {
  allowlistAuthorizationSatisfied: boolean;
};

export async function evaluateSystemRunAllowlist(params: {
  shellCommand: string | null;
  argv: string[];
  approvals: ExecApprovalsResolved;
  security: ExecSecurity;
  safeBins: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBins"];
  safeBinProfiles: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["safeBinProfiles"];
  trustedSafeBinDirs: ReturnType<typeof resolveExecSafeBinRuntimePolicy>["trustedSafeBinDirs"];
  cwd: string | undefined;
  env: Record<string, string> | undefined;
  skillBins: SkillBinTrustEntry[];
  autoAllowSkills: boolean;
}): Promise<SystemRunAllowlistAnalysis> {
  const context = {
    allowlist: params.approvals.allowlist,
    safeBins: params.safeBins,
    safeBinProfiles: params.safeBinProfiles,
    cwd: params.cwd,
    trustedSafeBinDirs: params.trustedSafeBinDirs,
    skillBins: params.skillBins,
    autoAllowSkills: params.autoAllowSkills,
  };
  let evaluation: ExecAllowlistAnalysis;
  if (params.shellCommand) {
    evaluation = await evaluateShellAllowlistWithAuthorization({
      ...context,
      command: params.shellCommand,
      env: params.env,
      platform: process.platform,
    });
  } else {
    const analysis = analyzeArgvCommand({ argv: params.argv, cwd: params.cwd, env: params.env });
    evaluation = {
      ...evaluateExecAllowlist({ ...context, analysis }),
      analysisOk: analysis.ok,
      segments: analysis.segments,
    };
  }
  return {
    ...evaluation,
    allowlistSatisfied:
      params.security === "allowlist" && evaluation.analysisOk && evaluation.allowlistSatisfied,
    allowlistAuthorizationSatisfied: evaluation.analysisOk && evaluation.allowlistSatisfied,
  };
}

/** Resolve the single planned argv that can replace the caller argv after allowlist approval. */
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
  const plannedAllowlistArgv = resolvePlannedSegmentArgv(
    expectDefined(params.segments[0], "segments entry at 0"),
  );
  return plannedAllowlistArgv && plannedAllowlistArgv.length > 0 ? plannedAllowlistArgv : null;
}

export async function resolveSystemRunExecArgv(params: {
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
  segmentSatisfiedBy: ExecSegmentSatisfiedBy[];
  authorizationPlan: ExecAuthorizationPlan | undefined;
}): Promise<string[] | null> {
  const execArgv = params.plannedAllowlistArgv ?? params.argv;
  if (
    params.security !== "allowlist" ||
    params.policy.approvedByAsk ||
    !params.shellCommand ||
    !params.policy.analysisOk ||
    !params.policy.allowlistSatisfied
  ) {
    return execArgv;
  }
  const transportArgv = resolveShellWrapperTransportArgv(params.argv);
  const executable = normalizeExecutableToken(transportArgv?.[0] ?? "");
  const parseableTransport =
    transportArgv && POSIX_PARSEABLE_SHELL_WRAPPERS.has(executable) ? transportArgv : null;
  if (POSIX_SHELL_WRAPPERS.has(executable) && !parseableTransport) {
    return null;
  }
  if (params.isWindows) {
    // Exact-path matches stay bound to the resolved executable, while the bare
    // wildcard contract can still authorize unresolved Windows commands.
    return params.segments.length === 1
      ? resolvePlannedSegmentArgv(expectDefined(params.segments[0], "segments entry at 0"))
      : execArgv;
  }
  if (
    !parseableTransport ||
    !params.segmentSatisfiedBy.some((entry) => entry === "safeBins" || entry === "inlineChain")
  ) {
    return execArgv;
  }
  if (!params.authorizationPlan) {
    return null;
  }
  const rebuilt = buildAuthorizedShellCommandFromPlan({
    plan: params.authorizationPlan,
    mode: "safeBins",
    segmentSatisfiedBy: params.segmentSatisfiedBy,
  });
  if (!rebuilt.ok || !rebuilt.command) {
    return null;
  }
  return replacePosixShellInlineCommand({
    argv: params.argv,
    transportArgv: parseableTransport,
    oldCommand: params.shellCommand,
    nextCommand: rebuilt.command,
  });
}

function findSubsequence(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0 || needle.length > haystack.length) {
    return -1;
  }
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((value, offset) => haystack[start + offset] === value)) {
      return start;
    }
  }
  return -1;
}

function replacePosixShellInlineCommand(params: {
  argv: string[];
  transportArgv: string[];
  oldCommand: string;
  nextCommand: string;
}): string[] | null {
  const { transportArgv } = params;
  const transportStart = findSubsequence(params.argv, transportArgv);
  if (transportStart < 0) {
    return null;
  }
  const match = resolveInlineCommandMatch(transportArgv, POSIX_INLINE_COMMAND_FLAGS, {
    allowCombinedC: true,
  });
  if (match.valueTokenIndex === null) {
    return null;
  }
  const absoluteValueIndex = transportStart + match.valueTokenIndex;
  const token = params.argv[absoluteValueIndex]?.trimEnd();
  if (token === undefined) {
    return null;
  }
  if (!token.endsWith(params.oldCommand)) {
    return null;
  }
  // Combined shell flags can leave the inline command in a suffix of the same argv token.
  const rewritten = [...params.argv];
  rewritten[absoluteValueIndex] =
    token.slice(0, token.length - params.oldCommand.length) + params.nextCommand;
  return rewritten;
}

/** Mark truncated output in stderr when possible, otherwise stdout. */
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
