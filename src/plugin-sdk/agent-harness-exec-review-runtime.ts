// Focused exec auto-review helpers for plugin-owned agent harnesses.
//
// Keep this out of agent-harness-runtime: model-backed review construction
// reaches provider/auth discovery and would create an architecture cycle through
// the broad harness barrel.

import type { ExecAutoReviewHost } from "../infra/exec-auto-review.js";

/**
 * Review an exec request using the configured model without executing it.
 * Handle all three results explicitly: `allow-once` with low/medium risk permits
 * one execution; `ask` routes to human approval; `deny` must not run or escalate
 * to human approval and must return the rationale and rejection guidance to the
 * agent. Provider failures, timeouts, and invalid responses become `ask`;
 * detected reviewer-directed prompt injection becomes high-risk `deny`.
 * Facade loading or reviewer construction errors may still reject the promise.
 */
export async function reviewExecRequestWithConfiguredModel(params: {
  cfg?: import("../config/types.openclaw.js").OpenClawConfig;
  agentId?: string;
  reviewer?: unknown;
  input: import("../infra/exec-auto-review.js").ExecAutoReviewInput;
}): Promise<import("../infra/exec-auto-review.js").ExecAutoReviewDecision> {
  const { createModelExecAutoReviewer } = await import("../agents/exec-auto-reviewer.js");
  const reviewer = createModelExecAutoReviewer({
    cfg: params.cfg,
    agentId: params.agentId,
    reviewer: params.reviewer as
      | import("../agents/exec-auto-reviewer.js").ExecReviewerConfig
      | undefined,
  });
  return reviewer(params.input);
}

/**
 * Build review input for a supported shell command, or return `undefined` when
 * this helper cannot review it. This does not authorize execution; consumers of
 * the subsequent review must handle `allow-once`, `deny`, and `ask` explicitly.
 */
export async function buildExecAutoReviewInputForShellCommand(params: {
  command: string;
  cwd?: string | null;
  host: import("../infra/exec-auto-review.js").ExecAutoReviewHost;
  envKeys?: readonly string[];
  agent?: {
    id?: string | null;
    sessionKey?: string | null;
  };
}): Promise<import("../infra/exec-auto-review.js").ExecAutoReviewInput | undefined> {
  const [
    { commandRequiresSecurityAuditSuppressionApproval, evaluateShellAllowlistWithAuthorization },
    { detectUnsafeExecControlShellCommand },
    { detectPolicyInlineEval },
    { isBlockedShellWrapperCommand },
  ] = await Promise.all([
    import("../infra/exec-approvals.js"),
    import("../infra/exec-control-command-guard.js"),
    import("../infra/command-analysis/policy.js"),
    import("../infra/exec-wrapper-resolution.js"),
  ]);
  const command = params.command.trim();
  const host: ExecAutoReviewHost = params.host;
  if (!command) {
    return undefined;
  }
  const allowlistEval = await evaluateShellAllowlistWithAuthorization({
    command,
    allowlist: [],
    safeBins: new Set<string>(),
    cwd: params.cwd ?? undefined,
    platform: process.platform,
  });
  const [segment] = allowlistEval.segments;
  const boundSingleCommand =
    allowlistEval.analysisOk &&
    allowlistEval.segments.length === 1 &&
    segment !== undefined &&
    segment.raw.trim() === command;
  if (!boundSingleCommand) {
    return undefined;
  }
  // Blocked carriers and startup files execute outside the reviewed payload.
  if (segment.resolution?.policyBlocked === true || isBlockedShellWrapperCommand(segment.argv)) {
    return undefined;
  }
  if (
    commandRequiresSecurityAuditSuppressionApproval({
      command,
      cwd: params.cwd ?? undefined,
      segments: allowlistEval.segments,
    })
  ) {
    return undefined;
  }
  if ((await detectUnsafeExecControlShellCommand(command)) !== null) {
    return undefined;
  }
  const inlineEval = detectPolicyInlineEval(allowlistEval.segments) !== null;
  const heredoc = segment.argv.some((token) => token.startsWith("<<"));
  return {
    command,
    argv: segment.argv,
    cwd: params.cwd ?? null,
    envKeys: params.envKeys,
    host,
    reason: inlineEval ? "strict-inline-eval" : heredoc ? "heredoc" : "approval-required",
    analysis: {
      parsed: true,
      allowlistMatched: false,
      inlineEval,
      ...(heredoc ? { heredoc } : {}),
    },
    agent: params.agent,
  };
}
