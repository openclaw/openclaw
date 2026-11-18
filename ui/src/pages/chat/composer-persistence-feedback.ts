import { t } from "../../i18n/index.ts";

export function chatComposerDraftStorageError(): string {
  return t("chat.queue.draftStorageFailed");
}

export function reportChatComposerDraftStorageError(host: {
  lastError?: string | null;
  chatError?: string | null;
}): void {
  host.lastError = chatComposerDraftStorageError();
  host.chatError = chatComposerDraftStorageError();
}
