import { t } from "../../i18n/index.ts";

export function chatComposerDraftStorageError(): string {
  return t("chat.queue.draftStorageFailed");
}

export function reportChatComposerDraftStorageError(
  host: {
    lastError?: string | null;
    chatError?: string | null;
  },
  operation: "save" | "restore" = "save",
): void {
  const message =
    operation === "restore"
      ? t("chat.outboxRecoveryStorageFailed")
      : chatComposerDraftStorageError();
  host.lastError = message;
  host.chatError = message;
}
