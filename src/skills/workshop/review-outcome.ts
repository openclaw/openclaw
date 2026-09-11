import type { EmbeddedAgentRunResult } from "../../agents/embedded-agent-runner/types.js";

export function assertSkillReviewRunSucceeded(
  result: Pick<EmbeddedAgentRunResult, "meta" | "payloads">,
): void {
  const errorPayload = result.payloads?.find((payload) => payload.isError);
  const message =
    result.meta.error?.message.trim() ||
    result.meta.failureSignal?.message.trim() ||
    (result.meta.aborted ? "Skill review model run aborted." : undefined) ||
    errorPayload?.text?.trim();
  if (message || errorPayload) {
    throw new Error(message || "Skill review model run failed.");
  }
}
