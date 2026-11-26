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
      reviewTitle: "Review dictated text",
      reviewBeforeSend: "Review the recording before sending.",
      waitBeforeRecording: "Wait for the current recording to finish before starting another.",
      reviewBeforeRecording: "Review or cancel the current recording before starting another.",
      originalReady: "The recognized text needs your review. No correction was applied.",
      original: "Original recognized text",
      candidate: "Proposed correction",
      noCandidate: "No correction is available. You can keep the original text or cancel.",
      keepOriginal: "Keep original",
      accept: "Accept correction",
      cancel: "Cancel",
      boundary: "Only this recording's unsent text can change. Nothing is sent automatically.",
      reasons: {
        "corrections-unavailable":
          "Spoken corrections are unavailable. The recognized text has been kept unchanged.",
        "source-changed":
          "The draft or connection changed. This earlier correction can no longer be accepted.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatCorrectionsEnglish = Object.assign(
  () => Object.assign(en.chat, enChatCorrections.chat),
  { catalog: enChatCorrections },
);
