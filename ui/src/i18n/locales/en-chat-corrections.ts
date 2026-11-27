import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatCorrections = {
  chat: {
    corrections: {
      policy: "Spoken corrections",
      off: "Off",
      explicit: "Review original (corrections unavailable)",
      literal: "Literal for this recording",
      literalHint: "Keep correction words as dictated text for the next recording.",
      reviewBeforeSend: "Review the recording before sending.",
      waitBeforeRecording: "Wait for the current recording to finish before starting another.",
      reviewBeforeRecording: "Review or cancel the current recording before starting another.",
    },
  },
} satisfies TranslationMap;

export const registerChatCorrectionsEnglish = Object.assign(
  () => Object.assign(en.chat.corrections, enChatCorrections.chat.corrections),
  { catalog: enChatCorrections },
);
