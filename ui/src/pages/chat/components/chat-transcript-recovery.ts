import type { AssistantMessageExpansionState } from "../chat-message-recovery.ts";
import { getExpansionStateVersion, pruneAssistantMessageExpansions } from "../chat-thread.ts";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { createTranscriptMemo } from "./chat-transcript-memo.ts";

const expansionPrunes = createTranscriptMemo<void>();

export function pruneTranscriptExpansions(
  expandedAssistantMessages: Map<string, AssistantMessageExpansionState>,
  props: Pick<
    ChatThreadProps,
    "fullMessageAgentId" | "messages" | "toolMessages" | "pendingInputs"
  >,
): void {
  if (expandedAssistantMessages.size > 0) {
    expansionPrunes(
      expandedAssistantMessages,
      [
        props.fullMessageAgentId,
        props.messages,
        props.toolMessages,
        getExpansionStateVersion(expandedAssistantMessages),
        ...(props.pendingInputs ?? []),
      ],
      () =>
        pruneAssistantMessageExpansions(expandedAssistantMessages, props.fullMessageAgentId, [
          ...props.messages,
          ...props.toolMessages,
          ...(props.pendingInputs ?? []).map((input) => input.message),
        ]),
    );
  }
}
