import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Loads with dictation capture; keep it out of the composer's startup copy.
const enChatDictation = {
  chat: {
    dictation: {
      busy: "Dictation is busy finishing earlier recordings. Try again in a moment.",
      punctuation: {
        title: "Dictation punctuation",
        settingsDescription:
          "Optional review before inserting dictated text in this browser. Changes apply to your next recording. Your transcription provider and Talk responses stay the same.",
        policy: "Punctuation policy",
        mode: "Mode",
        off: "Off (existing dictation behavior)",
        verbatim: "Verbatim",
        automatic: "Automatic",
        explicit: "Explicit",
        locale: "Punctuation language",
        localeUnset: "Not selected (preserve original)",
        englishUs: "English (United States)",
        enableExplicit: "Allow spoken punctuation commands in Explicit mode",
        fragment: "Keep as a fragment; do not add a sentence ending",
        policyHelp:
          "Automatic currently supports English (United States). It can capitalize a sentence opening and add a final period. Other selected languages, uncertain text, and missing context keep the original. Review every result before inserting it.",
        explicitHelp:
          "Explicit also needs the separate command permission. Say “insert comma”, “insert period”, or another supported mark. The greeting shorthand “hello comma world period” is also supported. Other bare punctuation words remain literal.",
        verbatimHelp:
          "Verbatim preserves the recognizer’s output. It cannot recover words or punctuation the recognizer already changed.",
        invalidPreference:
          "The saved punctuation preference is invalid or from an unsupported version. Refinement is off. Choose a supported policy or reset it; other settings are unchanged.",
        resetPreference: "Reset punctuation preference",
        reviewTitle: "Review dictation",
        original: "Original recognizer text",
        proposed: "Proposed text",
        selectedOriginal: "Selected original text",
        changePolicy: "Change policy for this result",
        reprocessHelp:
          "Reprocess starts from the original recording text and replaces this unsent review. It does not change your saved preference or insert text.",
        reprocess: "Reprocess original",
        dismiss: "Dismiss review",
        undo: "Undo dictation insertion",
        useOriginal: "Use original",
        insert: "Insert into draft",
        status: {
          refined: "Punctuation changes are ready for review.",
          "raw-fallback": "Original text is ready for review.",
          "needs-review": "This result needs review; the original text was preserved.",
          unavailable: "A final eligible result is unavailable.",
        },
        limitations: {
          "draft-changed":
            "The draft or destination changed. Automatic insertion is blocked; your current draft is unchanged.",
          "source-revoked":
            "Permission for the source was revoked. This result cannot be reused; record again with the current permissions.",
          "transcript-incomplete":
            "The provider did not return a complete final transcript. Recoverable text is shown for reference; record again before inserting.",
        },
        delivery: {
          "not-attempted": "",
          pending: "Insertion is in progress.",
          committed: "Inserted into the draft. This result will not be inserted again.",
          "not-committed":
            "The destination did not accept the insertion. This result will not retry.",
          "outcome-unknown":
            "Insertion was attempted, but its outcome is unknown. Check the draft; this result will not retry.",
        },
        undoOutcome: {
          pending: "Undo is in progress.",
          undone: "The dictation insertion was undone.",
          "not-undone": "The draft changed or no undo transaction is available.",
          "outcome-unknown": "Undo was attempted, but its outcome is unknown. Check the draft.",
        },
        reasons: {
          verbatim: "Verbatim preserves recognizer output.",
          unchanged: "No permitted changes were needed.",
          "unsupported-locale":
            "Select English (United States) to enable the supported punctuation rules.",
          "mixed-locale": "The language is mixed or uncertain.",
          "context-unavailable": "The surrounding text was unavailable or not authorized.",
          "explicit-disabled": "Spoken punctuation commands are not enabled.",
          "ambiguous-command": "A punctuation word may be ordinary speech.",
          "unsupported-version": "This result uses an unsupported policy version.",
          "invalid-request": "The punctuation request was not valid.",
          "incomplete-transcript": "The transcript is not final.",
          "input-too-large": "The text exceeds the local processing limit.",
          "invalid-protected-span": "A protected text range could not be validated.",
          "invalid-candidate": "The proposed result could not be validated.",
          "revision-mismatch": "The proposed result belongs to an older recording revision.",
          "invalid-edit-map": "The proposed changes could not be mapped safely to the original.",
          "protected-text": "A proposed change would alter protected text.",
          "lexical-change": "A proposed change would alter the words.",
          "unapproved-edit": "A proposed change is outside the selected punctuation policy.",
          "output-too-large": "The proposed result exceeds the local processing limit.",
        },
      },
    },
  },
} satisfies TranslationMap;

export const registerChatDictationEnglish = Object.assign(
  () => Object.assign(en.chat, enChatDictation.chat),
  { catalog: enChatDictation },
);
