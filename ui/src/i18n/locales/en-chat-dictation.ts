import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Loads with dictation capture; keep it out of the composer's startup copy.
const enChatDictation = {
  chat: {
    dictation: {
      busy: "Dictation is busy finishing earlier recordings. Try again in a moment.",
      cleanupDescription:
        "Review the original recognized text before adding it to this unsent draft.",
      cleanupMode: "Cleanup mode",
      cleanupOff: "Off",
      cleanupConservative: "Conservative — English (unavailable)",
      cleanupPolicyHelp:
        "Cleanup is unavailable. Conservative keeps the original text for review. Changes apply to the next recording.",
      cleanupOffHelp:
        "Off keeps the recognizer’s text. It cannot restore words the recognizer already omitted.",
      cleanupPending: "Preparing original text…",
      cleanupReady: "Choose the original text. Nothing has been sent.",
      cleanupApplied: "Text is in the unsent draft. You can still restore the original.",
      cleanupFailed: "Review could not finish. The original text is still available.",
      cleanupSemanticUnavailable:
        "Cleanup is unavailable. The original recognized text is unchanged.",
      cleanupUncertain:
        "The draft update could not be confirmed. Check your draft before copying text. It will not be applied again.",
      cleanupUnavailable:
        "This recording is no longer available for this draft. Record again to continue.",
      cleanupOriginal: "Original recognized text",
      cleanupCandidate: "Cleaned draft",
      cleanupRemovals: "Suggested removals",
      cleanupHesitation: "Hesitation",
      cleanupRestart: "Exact restart",
      cleanupUseOriginal: "Use original",
      cleanupRestoreOriginal: "Restore original",
      cleanupUseCandidate: "Use cleaned draft",
      cleanupRetry: "Review again",
      cleanupDismiss: "Dismiss review",
      cleanupCopy: "Copy original text",
      cleanupManualRecovery:
        "This review cannot replace the current draft. Copy or select the original text for manual recovery.",
      cleanupReviewHint:
        "Closing keeps this review available. Dismissing releases it without changing the draft.",
    },
  },
} satisfies TranslationMap;

export const registerChatDictationEnglish = Object.assign(
  () => Object.assign(en.chat, enChatDictation.chat),
  { catalog: enChatDictation },
);
