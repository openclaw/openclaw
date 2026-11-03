import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatFailedMessageEdit = {
  chat: {
    failedMessageEdit: {
      label: "Edit message",
      draftBlocked: "Send or clear your current draft before editing this message.",
    },
  },
} satisfies TranslationMap;

export const registerChatFailedMessageEditEnglish = Object.assign(
  () => mergeCatalog(en, enChatFailedMessageEdit),
  { catalog: enChatFailedMessageEdit },
);
