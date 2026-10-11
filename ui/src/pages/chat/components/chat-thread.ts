import { solidContent } from "../../../lit/solid-content.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";
import { ChatThread } from "./chat-thread-view.tsx";
import type { ChatTranscriptController } from "./chat-transcript-controller.ts";

export { ChatThread } from "./chat-thread-view.tsx";

/** Remaining Lit callers share the native transcript's retained Solid root. */
export function renderChatThread(props: ChatThreadProps, transcript: ChatTranscriptController) {
  return solidContent(ChatThread, { props, transcript });
}
