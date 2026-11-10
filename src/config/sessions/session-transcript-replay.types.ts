import { BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE } from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";

export type SessionTranscriptReplayGroup = {
  entryId: string;
  message: AgentMessage;
  carriers: AgentMessage[];
};

export type SessionTranscriptReplaySelection = {
  entryIds: string[];
  maxBytes?: number;
};

/** Bookkeeping can separate a user from its carriers without starting another model turn. */
export function isSessionTranscriptReplayMetadataType(type: unknown, customType: unknown): boolean {
  return (
    type === "thinking_level_change" ||
    type === "model_change" ||
    (type === "custom" && customType !== BACKGROUND_RESULT_PLACEMENT_CUSTOM_TYPE) ||
    type === "label" ||
    type === "session_info"
  );
}

/** Bound both request metadata and uncompressed transcript payload acquisition. */
export function validateSessionTranscriptReplaySelection(
  selection: SessionTranscriptReplaySelection,
): number {
  const maxBytes = selection.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024) {
    throw new RangeError("Replay maxBytes must be an integer between 1 and 67108864");
  }
  if (
    !Array.isArray(selection.entryIds) ||
    selection.entryIds.length > 10_000 ||
    selection.entryIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 1024)
  ) {
    throw new RangeError(
      "Replay entryIds must contain at most 10000 nonempty IDs of at most 1024 characters",
    );
  }
  return maxBytes;
}
