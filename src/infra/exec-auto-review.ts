import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { formatErrorMessage } from "./errors.js";

/** Risk level returned by exec auto-reviewers for approval routing decisions. */
type ExecAutoReviewRisk = "unknown" | "low" | "medium" | "high";

/**
 * Auto-review outcome: `allow-once` with low/medium risk permits one execution;
 * `ask` requests human approval. Plugin consumers must handle `deny` explicitly:
 * do not run, return the rationale and rejection guidance to the agent, and never
 * escalate that denial to human approval. The configured exec reviewer maps
 * provider failures, timeouts, and invalid responses to `ask`; detected
 * reviewer-directed prompt injection maps to `deny` with high risk.
 */
export type ExecAutoReviewDecision =
  | {
      decision: "allow-once";
      rationale: string;
      risk: "low" | "medium";
      userAuthorization?: ExecAutoReviewRisk;
    }
  | {
      decision: "deny";
      rationale: string;
      risk: ExecAutoReviewRisk;
      userAuthorization?: ExecAutoReviewRisk;
    }
  | {
      decision: "ask";
      rationale: string;
      risk: ExecAutoReviewRisk;
      userAuthorization?: ExecAutoReviewRisk;
    };

/** Execution host whose command policy context is being reviewed. */
export type ExecAutoReviewHost = "gateway" | "node" | "codex-app-server";

export type ExecAutoReviewTranscriptEntry = {
  kind: "user" | "assistant" | "tool_call" | "tool_result";
  text: string;
  toolName?: string;
  toolCallId?: string;
  origin?: "operator" | "channel" | "inter_session" | "internal_system" | "unknown";
  truncated?: boolean;
};

export type ExecAutoReviewTranscript = {
  entries: readonly ExecAutoReviewTranscriptEntry[];
  omittedEntries: number;
  truncated: boolean;
};

/** Command and policy facts supplied to an exec auto-reviewer. */
export type ExecAutoReviewInput = {
  transcript?: ExecAutoReviewTranscript;
  command: string;
  argv?: readonly string[];
  resolvedPath?: string | null;
  cwd?: string | null;
  envKeys?: readonly string[];
  host: ExecAutoReviewHost;
  reason:
    | "approval-required"
    | "allowlist-miss"
    | "strict-inline-eval"
    | "heredoc"
    | "execution-plan-miss";
  analysis: {
    parsed: boolean;
    allowlistMatched: boolean;
    safeBinMatched?: boolean;
    durableApprovalMatched?: boolean;
    inlineEval: boolean;
    heredoc?: boolean;
    shellWrapper?: boolean;
  };
  agent?: {
    id?: string | null;
    sessionKey?: string | null;
  };
};

/** Capability request supplied to the same configured model-backed reviewer. */
export type BoardWidgetAutoReviewInput = {
  kind: "board-widget";
  name: string;
  declared: { netOrigins?: string[]; tools?: string[] };
  agent?: { id?: string | null; sessionKey?: string | null };
};

/** Reviewer function used by gateway/node exec paths before human approval fallback. */
export type ExecAutoReviewer = (
  input: ExecAutoReviewInput,
) => Promise<ExecAutoReviewDecision> | ExecAutoReviewDecision;

export const EXEC_AUTO_REVIEW_DENIAL_GUIDANCE =
  "Do not attempt the same outcome through a workaround, indirect execution, or policy circumvention. Proceed only with a materially safer alternative, or ask the user to approve this exact command after explaining the risk.";

export const EXEC_AUTO_REVIEW_SHELL_STARTUP_WARNING =
  "Exec auto-review skipped: login or interactive shell startup requires human approval";

export const EXEC_AUTO_REVIEW_DISPATCH_IDENTITY_WARNING =
  "Exec auto-review skipped: dispatch chain cannot be bound";

export function formatExecAutoReviewAssessment(decision: ExecAutoReviewDecision): string {
  return `risk=${decision.risk}${decision.userAuthorization ? `, authorization=${decision.userAuthorization}` : ""}`;
}

/** Keeps reviewer and provider explanations safe for human-facing approval text. */
export function normalizeExecAutoReviewRationale(value: unknown, fallback: string): string {
  const text = normalizeOptionalString(typeof value === "string" ? value : undefined);
  const sanitized = sanitizeTerminalText(text ?? fallback)
    .replace(/[\p{Cf}\u2028\u2029]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  return truncateUtf16Safe(sanitized || fallback, 500);
}

/** Turns reviewer and provider failures into a bounded, redacted human-review decision. */
export function buildExecAutoReviewFailureDecision(
  prefix: string,
  error: unknown,
): ExecAutoReviewDecision {
  return {
    decision: "ask",
    risk: "unknown",
    rationale: normalizeExecAutoReviewRationale(`${prefix}: ${formatErrorMessage(error)}`, prefix),
  };
}

/** Reviewer failures become ask decisions; each approval owner applies its own policy. */
export async function resolveExecAutoReviewDecision<TInput>(
  reviewer: (input: TInput) => Promise<ExecAutoReviewDecision> | ExecAutoReviewDecision,
  input: TInput,
): Promise<ExecAutoReviewDecision> {
  try {
    return await reviewer(input);
  } catch (error) {
    return buildExecAutoReviewFailureDecision("exec reviewer failed", error);
  }
}

/**
 * Conservative fallback used when no model-backed reviewer is available.
 * Auto mode must never become a static allowlist; without a reviewer, defer to
 * the normal human approval route.
 */
export const defaultExecAutoReviewer: ExecAutoReviewer = (input) => {
  return {
    decision: "ask",
    rationale: `no model-backed exec reviewer is configured for ${input.host}`,
    risk: input.analysis.inlineEval ? "medium" : "unknown",
  };
};
