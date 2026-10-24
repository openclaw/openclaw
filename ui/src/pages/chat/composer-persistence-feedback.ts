export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

export function reportChatComposerDraftStorageError(host: {
  lastError?: string | null;
  chatError?: string | null;
}): void {
  host.lastError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
  host.chatError = CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
}
