import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";
import { resolveToolDisplay } from "../../agents/tool-display.js";

export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const errorPayload = result.payloads?.find((payload) => payload.isError);
  const unresolvedError = result.meta.toolSummary?.unresolvedError;
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
