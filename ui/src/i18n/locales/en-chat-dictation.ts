import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Loads with dictation capture; keep it out of the composer's startup copy.
const enChatDictation = {
  chat: {
    dictation: {
      busy: "Dictation is busy finishing earlier recordings. Try again in a moment.",
      cleanupDescription:
        "Review suggested removals before adding recognized text to this unsent draft.",
      cleanupMode: "Cleanup mode",
      cleanupOff: "Off",
      cleanupConservative: "Conservative — English",
      cleanupPolicyHelp:
        "Conservative cleanup supports English only. Choose it only when dictating English; other languages and mixed-language speech should use Off. Changes apply to the next recording.",
      cleanupOffHelp:
        "Off keeps the recognizer’s text. It cannot restore words the recognizer already omitted.",
      cleanupPending: "Checking suggested removals…",
      cleanupReady: "Choose the original text or the cleaned draft. Nothing has been sent.",
      cleanupApplied: "Cleaned text is in the unsent draft. You can still restore the original.",
      cleanupFailed: "Cleanup could not finish. Review the original text or retry cleanup.",
      cleanupUncertain:
        "The draft update could not be confirmed. Check your draft before copying text. It will not be applied again.",
      cleanupUnavailable:
        "This recording is no longer available for this draft. Record again to continue.",
      cleanupOriginal: "Original recognized text",
      cleanupCandidate: "Cleaned draft",
      cleanupRemovals: "Suggested removals",
      cleanupNoRemovals: "No safe removals were found. The original text is unchanged.",
      cleanupHesitation: "Hesitation",
      cleanupRestart: "Exact restart",
      cleanupUseOriginal: "Use original — restore all removals",
      cleanupRestoreOriginal: "Restore original",
      cleanupUseCandidate: "Use cleaned draft",
      cleanupRetry: "Retry cleanup",
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
