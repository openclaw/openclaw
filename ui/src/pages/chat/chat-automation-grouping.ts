import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import {
  chatItemGroups,
  groupBoundaryId,
  type AgentRunFrameRenderItem,
  type coalesceAgentRunFrames,
} from "./chat-agent-run-grouping.ts";
import { assistantMessageIsInterrupted } from "./chat-assistant-reply.ts";
import { readAutomationRun } from "./chat-turn-boundary.ts";

type Input = ReturnType<typeof coalesceAgentRunFrames>[number];
export type AutomationActivity = {
  kind: "automation-activity";
  key: string;
  jobId: string;
  sourceSessionKey: string;
  runs: Array<{ input: MessageGroup; frame?: AgentRunFrameRenderItem }>;
};

// Fold presentation only, after execution ownership has been resolved. Human
// messages, visible replies, other jobs and notices keep their chronological place.
export function coalesceAutomationActivity(items: Input[]): Array<Input | AutomationActivity> {
  const result: Array<Input | AutomationActivity> = [];
  for (let index = 0; index < items.length; index += 1) {
    const input = items[index]!;
    const automation =
      input.kind === "group" && input.messages.length === 1
        ? readAutomationRun(input.messages[0]?.message)
        : undefined;
    if (
      !automation ||
      input.kind !== "group" ||
      input.messages.some((message) => message.replyTarget)
    ) {
      result.push(input);
      continue;
    }
    const next = items[index + 1];
    // Only attach a frame belonging to this recorded input. Never infer run
    // ownership from adjacency or from an automation's human-readable name.
    const boundaryId = groupBoundaryId(input);
    const frame =
      next?.kind === "agent-run-frame" &&
      next.outcome.kind !== "failed" &&
      boundaryId !== undefined &&
      next.boundaryId === boundaryId &&
      !chatItemGroups(next).some(
        (group) =>
          group.visibleContent === "non-text" ||
          group.messages.some(
            (message) =>
              assistantMessageIsInterrupted(message.message) ||
              (message.hasVisibleContent && group.role === "assistant"),
          ),
      ) &&
      !next.parts.some(
        (part) =>
          part.kind === "stream-run" &&
          part.parts.some((stream) => stream.kind !== "reading-indicator"),
      )
        ? next
        : undefined;
    if (frame) {
      index += 1;
    }
    const previous = result.at(-1);
    const run = { input, frame };
    if (
      previous?.kind === "automation-activity" &&
      previous.jobId === automation.jobId &&
      previous.sourceSessionKey === automation.sourceSessionKey
    ) {
      previous.runs.push(run);
    } else {
      result.push({
        kind: "automation-activity",
        key: "automation:" + input.key,
        jobId: automation.jobId,
        sourceSessionKey: automation.sourceSessionKey,
        runs: [run],
      });
    }
  }
  return result;
}
