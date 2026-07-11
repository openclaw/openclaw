import { analyzeArgvCommand, resolveAllowAlwaysPatternCoverage } from "../infra/exec-approvals.js";
import { planShellAuthorization } from "../infra/exec-authorization-plan.js";
import {
  extractShellWrapperCommand,
  isShellWrapperInvocation,
} from "../infra/exec-wrapper-resolution.js";
import {
  inspectHostExecEnvOverrides,
  sanitizeHostExecEnv,
  sanitizeSystemRunEnvOverrides,
} from "../infra/host-env-security.js";
import { buildSystemRunApprovalPlan } from "./invoke-system-run-plan.js";

export type SystemRunPrepareParams = {
  command?: unknown;
  rawCommand?: unknown;
  cwd?: unknown;
  env?: Record<string, string> | null;
  agentId?: unknown;
  sessionKey?: unknown;
  strictInlineEval?: unknown;
};

function buildEnvOverrideRejectionMessage(params: {
  rejectedOverrideBlockedKeys: string[];
  rejectedOverrideInvalidKeys: string[];
}): string {
  const details: string[] = [];
  if (params.rejectedOverrideBlockedKeys.length > 0) {
    details.push(`blocked override keys: ${params.rejectedOverrideBlockedKeys.join(", ")}`);
  }
  if (params.rejectedOverrideInvalidKeys.length > 0) {
    details.push(
      `invalid non-portable override keys: ${params.rejectedOverrideInvalidKeys.join(", ")}`,
    );
  }
  return `SYSTEM_RUN_DENIED: environment override rejected (${details.join("; ")})`;
}

function buildCoverageEnv(params: {
  argv: string[];
  env?: Record<string, string> | null;
}): { ok: true; env: Record<string, string> } | { ok: false; message: string } {
  const diagnostics = inspectHostExecEnvOverrides({
    overrides: params.env ?? undefined,
    blockPathOverrides: true,
  });
  if (
    diagnostics.rejectedOverrideBlockedKeys.length > 0 ||
    diagnostics.rejectedOverrideInvalidKeys.length > 0
  ) {
    return { ok: false, message: buildEnvOverrideRejectionMessage(diagnostics) };
  }
  const envOverrides = sanitizeSystemRunEnvOverrides({
    overrides: params.env ?? undefined,
    shellWrapper: isShellWrapperInvocation(params.argv),
  });
  return {
    ok: true,
    // Durable approval coverage must use the same environment policy as execution.
    env: sanitizeHostExecEnv({ overrides: envOverrides, blockPathOverrides: true }),
  };
}

async function buildAllowAlwaysCoverage(params: {
  argv: string[];
  rawCommand?: string | null;
  cwd: string | null | undefined;
  env: Record<string, string>;
  strictInlineEval?: boolean;
}) {
  const cwd = params.cwd ?? undefined;
  const shellWrapper = extractShellWrapperCommand(params.argv, params.rawCommand);
  if (shellWrapper.isWrapper) {
    if (!shellWrapper.command) {
      return { complete: false, patterns: [] };
    }
    const authorizationPlan = await planShellAuthorization({
      command: shellWrapper.command,
      cwd,
      env: params.env,
      platform: process.platform,
    });
    if (!authorizationPlan.ok) {
      return { complete: false, patterns: [] };
    }
    const candidates = authorizationPlan.groups.flatMap((group) => group.candidates);
    const reusableSegments = candidates
      .filter((candidate) => candidate.allowAlways)
      .map((candidate) => candidate.sourceSegment);
    const coverage = resolveAllowAlwaysPatternCoverage({
      segments: reusableSegments,
      cwd,
      env: params.env,
      platform: process.platform,
      strictInlineEval: params.strictInlineEval,
    });
    return {
      ...coverage,
      complete: coverage.complete && reusableSegments.length === candidates.length,
    };
  }
  const analysis = analyzeArgvCommand({ argv: params.argv, cwd, env: params.env });
  if (!analysis.ok) {
    return { complete: false, patterns: [] };
  }
  return resolveAllowAlwaysPatternCoverage({
    segments: analysis.segments,
    cwd,
    env: params.env,
    platform: process.platform,
    strictInlineEval: params.strictInlineEval,
  });
}

export async function prepareSystemRunApproval(params: SystemRunPrepareParams) {
  const prepared = buildSystemRunApprovalPlan(params);
  if (!prepared.ok) {
    return prepared;
  }
  const prepareEnv = buildCoverageEnv({
    argv: prepared.plan.argv,
    env: params.env ?? undefined,
  });
  if (!prepareEnv.ok) {
    return prepareEnv;
  }
  return {
    ok: true as const,
    plan: prepared.plan,
    allowAlwaysCoverage: await buildAllowAlwaysCoverage({
      argv: prepared.plan.argv,
      rawCommand: typeof params.rawCommand === "string" ? params.rawCommand : null,
      cwd: prepared.plan.cwd,
      env: prepareEnv.env,
      strictInlineEval: params.strictInlineEval === true,
    }),
  };
}
