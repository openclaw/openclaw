import { solidContent } from "../../../lit/solid-content.tsx";
import {
  ChatSessionSuggestions,
  type ChatSessionSuggestionsProps,
} from "./chat-session-suggestions.solid.tsx";

export function renderChatSessionSuggestions(props: ChatSessionSuggestionsProps) {
  return solidContent(ChatSessionSuggestions, props);
}
