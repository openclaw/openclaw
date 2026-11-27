import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Loads with dictation capture; keep it out of the composer's startup copy.
const enChatDictation = {
  chat: {
    dictation: {
      busy: "Dictation is busy finishing earlier recordings. Try again in a moment.",
    },
  },
} satisfies TranslationMap;

export const registerChatDictationEnglish = Object.assign(
  () => Object.assign(en.chat, enChatDictation.chat),
  { catalog: enChatDictation },
);
