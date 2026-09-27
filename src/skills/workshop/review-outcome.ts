import { parseReviewPreflightOverflowMessage } from "../../agents/embedded-agent-runner/run/review-overflow.js";
import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveToolDisplay } from "../../agents/tool-display.js";

export class SkillReviewOversizedRequestError extends Error {
  readonly estimatedPromptTokens: number;
  readonly promptBudgetBeforeReserve: number;
  constructor(params: { estimatedPromptTokens: number; promptBudgetBeforeReserve: number }) {
    super(
      `Skill experience review prompt exceeds effective budget: ` +
        `estimatedPromptTokens=${params.estimatedPromptTokens} ` +
        `promptBudgetBeforeReserve=${params.promptBudgetBeforeReserve}`,
    );
    this.name = "SkillReviewOversizedRequestError";
    this.estimatedPromptTokens = params.estimatedPromptTokens;
    this.promptBudgetBeforeReserve = params.promptBudgetBeforeReserve;
  }
}

/** The bounded review context itself cannot be admitted within the configured limits. */
export class SkillReviewOversizedContextError extends Error {
  readonly limitReason: string;
  constructor(limitReason: string) {
    super(`Skill experience review context exceeds the configured review limit: ${limitReason}`);
    this.name = "SkillReviewOversizedContextError";
    this.limitReason = limitReason;
  }
}

export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const errorPayload = result.payloads?.find((payload) => payload.isError);
  const unresolvedError = result.meta.toolSummary?.unresolvedError;
  const terminalError = result.meta.error;
  const parsedOverflow =
    terminalError?.kind === "context_overflow"
      ? parseReviewPreflightOverflowMessage(terminalError.message)
      : null;
  if (parsedOverflow) {
    throw new SkillReviewOversizedRequestError(parsedOverflow);
  }
  if (terminalError?.kind === "context_overflow") {
    throw new SkillReviewOversizedContextError(terminalError.message);
  }
  const message =
    result.meta.error?.message.trim() ||
    result.meta.failureSignal?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    errorPayload?.text?.trim() ||
    (unresolvedError
      ? `${resolveToolDisplay({ name: unresolvedError.toolName }).label} failed.`
      : undefined);
  if (message || errorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}
