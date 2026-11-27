import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatFileReferences = {
  chat: {
    fileReferences: {
      enable: "English file-reference commands for this session's local workspace",
      convert: "Convert file references to plain text",
      sendUnsupported:
        "Convert file references to plain text before sending. This conversation cannot deliver their object identities.",
      unsupported:
        "This provider or current-file shortcut is unavailable. Your original words remain in the draft.",
      conversionFailed:
        "The conversion could not be confirmed. Inspect the draft before continuing.",
    },
  },
} satisfies TranslationMap;

export const registerChatFileReferencesEnglish = Object.assign(
  () => mergeCatalog(en.chat, enChatFileReferences.chat),
  { catalog: enChatFileReferences },
);
