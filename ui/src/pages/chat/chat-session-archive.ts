import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

// Archived sessions keep no composer draft, so unarchiving starts empty.
export function setSelectedChatSessionArchived(state: ChatPageHost, archived: boolean): void {
  state.selectedChatSessionArchived = archived;
  if (archived) {
    releaseChatAttachmentPayloads(state.chatAttachments);
    state.chatMessage = "";
    state.chatMentions = [];
    state.chatGoalDraftMode = null;
    state.chatReplyTarget = null;
    state.chatAttachments = [];
    state.composerDraftChanged?.();
  }
}
