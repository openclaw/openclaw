import type { ChatHistoryState } from "./chat-transcript-metadata.ts";

export const CHAT_HISTORY_REQUEST_LIMIT = 80;
const CHAT_HISTORY_REQUEST_MAX_BYTES = 256 * 1024;
export const CHAT_HISTORY_TOOL_RESULT_MAX_CHARS = 2_000;

export function chatHistoryRequestParams(
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  cursor?: string,
  inputRunIds: string[] = [],
  historyState?: ChatHistoryState,
) {
  const knownState =
    cursor !== undefined && historyState
      ? {
          ...(historyState.pendingInputs
            ? { pendingInputs: historyState.stateRevision.pendingInputs }
            : {}),
          ...(historyState.sessionInfo
            ? { sessionInfo: historyState.stateRevision.sessionInfo }
            : {}),
          ...(method === "chat.startup" && historyState.commands
            ? { commands: historyState.stateRevision.commands }
            : {}),
        }
      : {};
  return {
    sessionKey,
    // Match automatic full-message recovery so cached rows keep their displayed text.
    maxChars: 500_000,
    toolResultMaxChars: CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
    knownState,
    ...(requestAgentId ? { agentId: requestAgentId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit: CHAT_HISTORY_REQUEST_LIMIT,
    maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES,
    ...(inputRunIds.length ? { inputRunIds } : {}),
  };
}
