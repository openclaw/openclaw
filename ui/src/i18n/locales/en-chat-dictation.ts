import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Review copy loads with the optional syntax runtime, not the capture transport.
const enChatDictation = {
  chat: {
    dictation: {
      snippets: {
        title: "Voice snippets",
        description:
          "Save exact text for dictation. Say “insert snippet” followed by a trigger as a standalone phrase.",
        enabled: "Enable voice snippets",
        disabledHint: "Turning snippets off preserves your saved definitions.",
        search: "Search snippet names and triggers",
        empty: "No snippets yet. Create one for a signature, address, or repeated paragraph.",
        noMatches: "No snippets match this search.",
        add: "New snippet",
        edit: "Edit snippet",
        delete: "Delete snippet",
        deleteConfirm:
          "Delete this saved definition? Text already inserted in a draft stays unchanged.",
        enable: "Enable",
        disable: "Disable",
        on: "Enabled",
        off: "Disabled",
        sensitive: "Sensitive content",
        name: "Name",
        locale: "Language tag",
        triggers: "Triggers, one per line",
        body: "Exact text",
        staticHint:
          "Placeholders, braces, dollar signs, links, and command-looking text stay literal. Bodies are never executed.",
        limits: "Up to 500 definitions, 8 triggers per snippet, and 16 KiB of UTF-8 text per body.",
        bytes: "{bytes} / 16384 bytes",
        save: "Save snippet",
        saved: "Snippet saved.",
        deleted: "Snippet deleted.",
        updated: "Snippet settings saved.",
        preview: "Plain-text preview",
        import: "Import JSON",
        importData: "Choose a version 1 snippet file",
        importReview: "Review import",
        importReplace: "Replace catalog",
        importWarning:
          "Import replaces your saved definitions atomically. Export a backup first. Every expansion will be reviewed before insertion.",
        importCount: "{count} definitions in this import",
        imported: "Snippet catalog imported.",
        export: "Export JSON",
        exportWarning:
          "Exports contain all authored text, including sensitive snippets. Keep the downloaded file private.",
        exported: "Snippet export downloaded.",
        refresh: "Reload saved catalog",
        refreshing: "Loading saved snippets…",
        conflictHint:
          "Your edits remain in the form. Reload the saved catalog, then reopen the definition before applying those edits.",
        collisions: "Conflicting definitions",
        reviewTitle: "Review dictation snippets",
        reviewReady: "Snippet ready for review.",
        reviewDescription:
          "Review the complete utterance before adding it to your draft. Saved snippet text remains literal.",
        reviewText: "Complete dictation preview",
        sourceText: "Original transcript; select a standalone command segment to expand",
        selectedPhrase: "Expand selected phrase",
        download: "Download plain text",
        encodingHint:
          "The plain-text download preserves exact text. Browser text fields can normalize line endings and cannot represent every control character.",
        choose: "Choose a snippet",
        insert: "Add to draft",
        working: "Checking current access…",
        fallback:
          "The original destination changed or cannot accept text. Use Download plain text to preserve the exact result, or select and copy it. No insertion will be retried automatically.",
        error: {
          "invalid-schema":
            "Use the version 1 static-snippet JSON format. Dynamic templates are unsupported.",
          "invalid-record":
            "Each snippet needs a valid name, ID, revision, text, enabled state, and sensitivity.",
          "invalid-locale": "Enter a valid language tag, such as en-US.",
          "invalid-trigger": "Enter one to eight trigger names, each at most 256 characters.",
          "invalid-encoding": "The text contains an invalid Unicode character.",
          "body-too-large": "A snippet body must fit within 16 KiB of UTF-8 text.",
          "catalog-too-large": "The catalog or import exceeds the 9 MiB JSON limit.",
          "too-many-snippets": "Keep at most 500 definitions, including disabled snippets.",
          "duplicate-id": "Every imported definition needs a distinct stable ID.",
          "trigger-collision":
            "An enabled definition already uses this trigger. Change the trigger or disable a conflicting definition.",
          conflict: "Saved snippets changed. Reload the catalog before saving again.",
          unavailable:
            "Snippets are unavailable for this connection. Reconnect and reopen this dialog.",
          identity: "A durable personal identity is required to save snippets on this Gateway.",
          unknown: "No enabled snippet matches this exact trigger.",
          disabled:
            "This snippet is disabled. Enable it in Voice snippets, then start a new capture.",
          cancelled: "This capture was cancelled. Start a new capture to continue.",
          "stale-catalog":
            "The saved definition changed or is no longer authorized. Cancel and start a new capture.",
          "changed-target":
            "The destination draft changed. Review and copy or download the text manually.",
          "unsupported-encoding":
            "The destination cannot preserve this text exactly. Download the plain-text result instead.",
          "invalid-selection":
            "Select a complete “insert snippet” phrase in the original transcript.",
          collision:
            "Several definitions match. The first ten saved matches are shown. Choose the intended snippet, or cancel and rename its trigger in Voice snippets.",
          "invalid-transform":
            "The text transform changed protected snippet text. Cancel and try again.",
          limit: "The expanded snippet text exceeds this capture’s limit.",
        },
      },
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
