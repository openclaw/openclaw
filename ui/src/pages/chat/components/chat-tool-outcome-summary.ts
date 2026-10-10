import { html } from "lit";
import type { summarizeAgentActivity } from "../../../../../src/agents/agent-activity-presentation.js";
import type { ToolCard } from "../../../lib/chat/chat-types.ts";
import type { resolveToolApprovalReviewOutcome } from "../../../lib/chat/tool-approval-reviews.ts";
import "./chat-tool-outcome-summary.solid.tsx";

// Temporary adapters for unported activity/transcript renderers.
export function renderToolOutcomeSummary(
  cards: readonly ToolCard[],
  includeCount = true,
  activity?: Parameters<typeof summarizeAgentActivity>[0],
) {
  return html`<openclaw-chat-tool-outcome-summary
    style="display: contents"
    .cards=${cards}
    .includeCount=${includeCount}
    .activity=${activity}
  ></openclaw-chat-tool-outcome-summary>`;
}

export function renderToolReviewOutcome(
  outcome: ReturnType<typeof resolveToolApprovalReviewOutcome>,
  reviewer = "Review",
) {
  return html`<openclaw-chat-tool-review-outcome
    style="display: contents"
    .outcome=${outcome}
    .reviewer=${reviewer}
  ></openclaw-chat-tool-review-outcome>`;
}
