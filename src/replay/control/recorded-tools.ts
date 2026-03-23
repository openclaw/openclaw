import type { TrajectoryV1 } from "../../research/contracts/index.js";
import { ReplayControlError } from "./errors.js";

export type RecordedToolLookup = {
  byToolCallId: Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      ok?: boolean;
      resultSummary?: string;
    }
  >;
};

export function buildRecordedToolLookup(trajectory: TrajectoryV1): RecordedToolLookup {
  const byToolCallId = new Map<
    string,
    {
      toolCallId: string;
      toolName: string;
      ok?: boolean;
      resultSummary?: string;
    }
  >();
  for (const toolCall of trajectory.toolCalls) {
    byToolCallId.set(toolCall.toolCallId, {
      toolCallId: toolCall.toolCallId,
      toolName: toolCall.toolName,
      ok: toolCall.ok,
      resultSummary: toolCall.resultSummary,
    });
  }
  return { byToolCallId };
}

export function resolveRecordedToolResult(params: {
  lookup: RecordedToolLookup;
  toolCallId: string;
  toolName: string;
}): {
  toolCallId: string;
  toolName: string;
  ok?: boolean;
  resultSummary?: string;
} {
  const recorded = params.lookup.byToolCallId.get(params.toolCallId);
  if (!recorded) {
    throw new ReplayControlError({
      code: "tool_not_recorded",
      status: 400,
      message: `No recorded output for toolCallId=${params.toolCallId}`,
    });
  }
  if (recorded.toolName !== params.toolName) {
    throw new ReplayControlError({
      code: "tool_not_recorded",
      status: 400,
      message:
        `Recorded tool name mismatch for toolCallId=${params.toolCallId}: ` +
        `expected=${recorded.toolName} got=${params.toolName}`,
    });
  }
  return recorded;
}
