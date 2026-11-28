import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    corrections: {
      reviewTitle: "Review dictated text",
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

export const registerChatCorrectionReviewEnglish = Object.assign(
  () => Object.assign(en.chat.corrections, catalog.chat.corrections),
  { catalog },
);
