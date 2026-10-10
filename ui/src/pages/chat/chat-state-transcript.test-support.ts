import { extractText } from "../../lib/chat/message-extract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { buildChatItems } from "./chat-thread-build.ts";

export function renderedTranscript(state: ChatPageHost) {
  return buildChatItems({
    paneId: "test",
    sessionKey: state.sessionKey,
    runId: state.chatRunId,
    messages: state.chatMessages,
    toolMessages: state.chatToolMessages,
    streamSegments: state.chatStreamSegments,
    stream: state.chatStream,
    streamStartedAt: state.chatStreamStartedAt,
    queue: state.chatQueue,
    showToolCalls: true,
  }).flatMap((item) => {
    if (item.kind === "group") {
      return item.messages.map(({ message }) => ({
        role: item.role,
        text: extractText(message),
      }));
    }
    return item.kind === "stream" ? [{ role: "assistant", text: item.text }] : [];
  });
}
