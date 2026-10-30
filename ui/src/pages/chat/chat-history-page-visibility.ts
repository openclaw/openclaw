import { projectChatReasoning } from "./chat-reasoning.ts";
import { isHandoffBoundaryItem } from "./chat-sessions-yield.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { selectedChatSessionRow } from "./chat-state-route.ts";
import { buildChatItems } from "./chat-thread-build.ts";

/** The caller supplies its accepted unique prepend; never inspect the loaded transcript. */
export function hasVisibleOlderHistoryPage(
  state: ChatPageHost,
  paneId: string,
  messages: unknown[],
): boolean {
  if (messages.length === 0) {
    return false;
  }
  const { showReasoning, reasoning } = projectChatReasoning({
    showThinking: state.settings.chatShowThinking,
    selectedSession: selectedChatSessionRow(state),
    reasoning: state.chatReasoning,
    runId: state.chatRunId,
  });
  return buildChatItems(
    {
      paneId,
      sessionKey: state.sessionKey,
      messages,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: state.settings.chatShowToolCalls,
      persistCommentary: state.settings.chatPersistCommentary !== false,
      showReasoning,
      reasoning,
    },
    undefined,
    "history",
  ).some((item) => !isHandoffBoundaryItem(item));
}
