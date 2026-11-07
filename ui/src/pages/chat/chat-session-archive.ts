import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

/**
 * Records the selected session's archive state. An archived session keeps no
 * composer draft, so unarchiving it starts with an empty composer.
 */
export function setSelectedChatSessionArchived(state: ChatPageHost, archived: boolean): void {
  state.selectedChatSessionArchived = archived;
  if (
    !archived ||
    (!state.chatMessage &&
      state.chatAttachments.length === 0 &&
      !state.chatMentions?.length &&
      !state.chatReplyTarget &&
      !state.chatGoalDraftMode)
  ) {
    return;
  }
  releaseChatAttachmentPayloads(state.chatAttachments);
  state.chatMessage = "";
  state.chatMentions = [];
  state.chatGoalDraftMode = null;
  state.chatReplyTarget = null;
  state.chatAttachments = [];
  // Persists the empty composer, which also clears the stored and durable draft.
  state.composerDraftChanged?.();
}
