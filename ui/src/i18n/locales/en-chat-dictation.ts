import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Review copy loads with the optional syntax runtime, not the capture transport.
const enChatDictation = {
  chat: {
    dictation: {
      developer: {
        enable: "Enable exact syntax review",
        mode: "Dictation mode",
        prose: "Prose",
        literal: "Literal",
        developer: "Developer",
        locale: "Spoken command language",
        chooseLocale: "Choose a supported language",
        english: "English (United States)",
        profile: "Syntax profile",
        plainCodeProfile: "Plain code (English)",
        jsonProfile: "JSON fragments (English)",
        typescriptProfile: "TypeScript fragments (English)",
        pythonProfile: "Python fragments (English)",
        grammar:
          "Use explicit scopes: start code … end code; spell … end spell; snake case … end identifier; literal words … end literal. Review never sends a message.",
        importLabel: "Profile JSON to import",
        import: "Import profile",
        export: "Show profile export",
        exportLabel: "Exportable profile JSON",
        review: "Review dictated syntax",
        raw: "Recognized original",
        candidate: "Exact preview",
        unresolved: "Resolve the highlighted commands or explicitly keep the recognized original.",
        alternatives: "Choose the intended literal",
        hyphenMinus: "Hyphen-minus (-)",
        minusSign: "Minus sign (−)",
        emDash: "Em dash (—)",
        incompleteDiagnostic:
          "The spoken command is incomplete. Finish its closing phrase or keep the recognized original.",
        ambiguousDiagnostic:
          "This symbol has more than one literal meaning. Choose the intended character before insertion.",
        syntaxDiagnostic:
          "The fragment has a mismatched delimiter or unsupported structure. No correction was invented.",
        unsupportedDiagnostic:
          "Choose English (United States) and a supported profile, or explicitly choose Prose. No English commands were applied.",
        invalidDiagnostic:
          "The command or profile could not be validated. Keep the recognized original or capture again.",
        limitDiagnostic:
          "The transcript or edit plan exceeds the supported size limit. Keep the original or capture a smaller fragment.",
        useOriginal: "Keep recognized original",
        undoLast: "Undo last preview transformation",
        inspect: "Inspect literal characters",
        characters: "Character names and Unicode values",
        characterLimit:
          "Character inspection shows the first 4,096 characters. Copy retains the complete text.",
        cancel: "Cancel review",
        copy: "Copy exact text",
        insert: "Insert into draft",
        copyOnly:
          "External editors and terminals are copy-only. Pasting a newline into a terminal can execute text.",
        copyRequired:
          "This composer cannot retain this exact result. Copy the preview to a compatible destination; insertion is unavailable.",
        invalidSettings:
          "Saved syntax settings are unsupported or invalid. They remain available for export; no syntax rules are active.",
        useProseFallback: "Use Prose for this session",
        proseFallback:
          "Prose dictation is active for this session. Saved syntax profiles were retained.",
        importFailed:
          "Profile import failed. Check the schema, mapping limits, and revision. Saved profiles were retained.",
        profileLimit: "Keep at most eight authored profiles. Existing profiles were retained.",
        imported: "Profile imported. Choose Literal or Developer and enable review to use it.",
        stale:
          "The draft, selection, account, or profile changed. Capture again to prepare a current preview.",
        invalidPlan:
          "The edit plan could not be validated. The recognized original remains available for review.",
        inserted: "Exact text was inserted into the draft. Nothing was sent.",
        uncertainWrite:
          "The editor could not confirm insertion. Check the draft before capturing again; this preview will not be retried.",
        copied: "Exact text copied.",
        copyFailed: "Copy failed. The preview was retained. Retry copying from this browser.",
        newline: "newline",
        carriageReturn: "carriage return",
        tab: "tab",
        space: "space",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatDictationEnglish = Object.assign(() => mergeCatalog(en, enChatDictation), {
  catalog: enChatDictation,
});
