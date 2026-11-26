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
      oneReady: "1 proposed correction is ready for review.",
      manyReady: "{count} proposed corrections are ready for review.",
      originalReady: "The recognized text needs your review. No correction was applied.",
      original: "Original recognized text",
      candidate: "Proposed correction",
      emptyCandidate: "No dictated text remains after this correction.",
      noCandidate: "No correction is available. You can keep the original text or cancel.",
      changes: "Inspect changed words",
      before: "Before",
      after: "After",
      removed: "Removed",
      keepOriginal: "Keep original",
      accept: "Accept correction",
      cancel: "Cancel",
      boundary: "Only this recording's unsent text can change. Nothing is sent automatically.",
      reasons: {
        "corrections-unavailable":
          "Spoken corrections are unavailable. The recognized text has been kept unchanged.",
        off: "Spoken corrections are off. The recognized text is unchanged.",
        literal: "Literal mode keeps correction words as recognized text.",
        "unsupported-locale":
          "Correction grammar is available only for English. The recognized text is unchanged.",
        "not-final": "Recognition has not supplied a complete final transcript.",
        "input-too-large":
          "This recording is too long for correction review. The recognized text is unchanged.",
        "plan-too-large":
          "This recording has too many proposed edits. The recognized text is unchanged.",
        "invalid-plan":
          "The proposed correction could not be validated. The recognized text is unchanged.",
        "source-changed":
          "The draft or connection changed. This earlier correction can no longer be accepted.",
        "invalid-range": "The correction did not identify a valid part of this recording.",
        "unicode-boundary":
          "The correction could split a written character, so it was not applied.",
        "duplicate-id": "Correction evidence was repeated. No correction was applied.",
        overlap: "Proposed corrections conflict with one another. No correction was applied.",
        "protected-span": "Quoted, code, or literal text is protected from this correction.",
        "no-target":
          "There is no unique editable target in this recording. Existing field text is unchanged.",
        "ambiguous-target":
          "More than one word or phrase could be the target. Choose the original or edit it yourself.",
        "chain-limit":
          "The correction chain is too long to resolve safely. The recognized text is unchanged.",
        "metadata-incomplete":
          "Recognition did not supply enough timing information to verify the correction. Compare both versions.",
        "metadata-reordered":
          "Recognition events arrived out of order. The recognized text needs review.",
        "cross-speaker": "The correction may cross speakers. The recognized text needs review.",
        "uncertain-scope":
          "The intended scope of the correction is unclear. The recognized text needs review.",
        "review-required":
          "Compare the original and proposed text before accepting this correction.",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatCorrectionsEnglish = Object.assign(
  () => Object.assign(en.chat, enChatCorrections.chat),
  { catalog: enChatCorrections },
);
