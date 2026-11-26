import { mergeCatalog } from "../lib/merge-catalog.ts";
import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    dictationFormatting: {
      title: "Review dictation",
      mode: "Dictation formatting",
      preserve: "Preserve recognized text",
      explicit: "Interpret explicit structure (English)",
      modeHint:
        "Preserve inserts recognized text directly. Explicit structure lets you confirm spoken paragraph, line, and list commands before applying them.",
      reprocessHint: "Mode changes apply to future recordings. Reprocess to update this preview.",
      preview: "Preview format",
      semantic: "Semantic preview",
      plain: "Plain text preview",
      original: "Recognized text",
      ready: "Review the preview before adding it to your message.",
      structure: "Preview: {paragraphs} paragraphs and {items} list items.",
      preserved: "Recognized text has been preserved. Review it before adding it to your message.",
      needsReview:
        "Confirm the phrases you intended as structure commands. Unselected words stay unchanged.",
      commandsLimit:
        "Command review is limited to 20 phrases. Keep the original text or make a shorter recording.",
      fallback: "Formatting was unavailable. The original recognized text is available below.",
      stale:
        "The insertion target changed or cannot accept this text. Copy it to use in your message.",
      wholeMessageHint:
        "To add formatted Markdown, select the whole message before recording. You can keep the original words or copy the preview.",
      committed: "Text was added to your message. Review the message before sending.",
      unknown:
        "Insertion could not be confirmed. Check your message before copying text to avoid duplicates.",
      formattedAction: "Use formatted text",
      originalAction: "Keep original",
      copy: "Copy plain text",
      copied: "Plain text copied.",
      copyFailed: "Copy failed. Select and copy the plain text preview manually.",
      reprocess: "Reprocess",
      commands: "Choose phrases to interpret as commands",
      commandsHint:
        "Only select a phrase if you intended it to change paragraphs, lines, or lists.",
      interpret: "Interpret selected commands",
      dismiss: "Dismiss",
    },
  },
} satisfies TranslationMap;

export const registerChatDictationFormattingEnglish = Object.assign(
  () => mergeCatalog(en, catalog),
  {
    catalog,
  },
);
