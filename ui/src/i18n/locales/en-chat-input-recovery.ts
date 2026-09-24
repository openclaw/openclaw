import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    inputRecovery: {
      interruptedStatus: "Not started",
      cancelledStatus: "Cancelled",
      send: "Send",
      discard: "Discard saved attempt",
      attachmentOnly: "Saved attachment",
      earlier: "Earlier saved attempts",
      latest: "Latest",
      readFailed: "Could not load the saved prompt. Try again.",
      cannotSend:
        "This saved prompt could not be restored safely. Its original text and attachments have not been sent.",
      dismissedStorageFailed:
        "Dismissed for this tab, but the choice could not be saved for reload.",
    },
  },
} satisfies TranslationMap;

export const registerChatInputRecoveryEnglish = Object.assign(
  () => Object.assign(en.chat.inputRecovery, catalog.chat.inputRecovery),
  { catalog },
);
