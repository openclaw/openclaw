import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Confirmation copy loads with its modal, not the chat boot catalog.
const enChatResetConfirmation = {
  chat: {
    sessionReset: {
      undoTitle: "Undo session reset?",
      undoDescription:
        "Restore the conversation from before this reset. Messages sent after the reset stay in another branch; they won’t be merged into the restored conversation.",
      undoConfirm: "Undo reset",
    },
    board: {
      resetTitle: "Reset conversation?",
      resetDescription: "The conversation context resets. Your dashboard stays.",
    },
  },
} satisfies TranslationMap;

export const registerChatResetConfirmationEnglish = Object.assign(
  () => {
    mergeCatalog(en, enChatResetConfirmation);
  },
  { catalog: enChatResetConfirmation },
);
