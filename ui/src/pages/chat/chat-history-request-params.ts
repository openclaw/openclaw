import type { ChatHistoryState } from "./chat-transcript-metadata.ts";

const CHAT_HISTORY_REQUEST_MAX_BYTES = 256 * 1024;
export const CHAT_HISTORY_TOOL_RESULT_MAX_CHARS = 2_000;

export function chatHistoryRequestParams(
  method: "chat.history" | "chat.startup",
  sessionKey: string,
  requestAgentId: string | undefined,
  cursor?: string,
  inputRunIds: string[] = [],
  historyState?: ChatHistoryState,
  compactOpening?: boolean,
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
    toolResultMaxChars: CHAT_HISTORY_TOOL_RESULT_MAX_CHARS,
    knownState,
    ...(requestAgentId ? { agentId: requestAgentId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    limit: compactOpening && cursor === undefined ? 24 : 80,
    maxBytes: CHAT_HISTORY_REQUEST_MAX_BYTES,
    ...(inputRunIds.length ? { inputRunIds } : {}),
  };
}
