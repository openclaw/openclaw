import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatFileReferences = {
  chat: {
    fileReferences: {
      enable: "English file-reference commands for this session's local workspace",
      literal: "Literal mode: keep command-like words as text",
      commandMode: "Allow a whole utterance beginning with reference file",
      instructions:
        "Say “reference file src slash auth dot ts end reference”. Use “literal … end literal” to keep commands as text. Every match needs your selection.",
      privacy:
        "Search uses authorized file metadata. Selection does not read contents, attach files, send a message, or grant agent access.",
      title: "Choose a file reference",
      progress: "Reference {current} of {total}",
      query: "Filename or relative path",
      search: "Search metadata",
      more: "Next candidates",
      inspect: "Inspect full path and workspace",
      results: "{count} candidates. Select the intended file.",
      incomplete: "More metadata may exist. These results do not establish a unique match.",
      selected: "Selected file",
      insert: "Insert bound reference",
      copyPath: "Copy relative path",
      copyReference: "Copy reference text",
      copyOnly:
        "This destination cannot carry file identity. Copied text is not a bound reference.",
      cancel: "Cancel",
      convert: "Convert file references to plain text",
      sendUnsupported:
        "Convert file references to plain text before sending. This conversation cannot deliver their object identities.",
      idle: "",
      preparing: "Preparing file-reference review…",
      searching: "Searching authorized metadata…",
      choosing: "Choose the intended file, then confirm.",
      confirming: "Revalidating the selected file…",
      committed: "File reference inserted into the unsent draft.",
      copied: "Plain text copied. The draft was not changed.",
      denied: "File metadata could not be authorized. Your original words remain in the draft.",
      unsupported:
        "This provider or current-file shortcut is unavailable. Your original words remain in the draft.",
      stale:
        "The file or draft changed. Start a new review; the original words were retained where no insertion occurred.",
      expired: "The chooser expired. Start a new review.",
      offline: "The connection is unavailable. The draft was preserved.",
      noMatches: "No candidates were returned. Refine the query or inspect the next page.",
      copyFailed: "The clipboard could not be written. The draft was not changed.",
      conversionFailed:
        "The conversion could not be confirmed. Inspect the draft before continuing.",
      unknown:
        "The insertion outcome is unknown. Inspect the draft; do not repeat insertion or copying.",
    },
  },
} satisfies TranslationMap;

export const registerChatFileReferencesEnglish = Object.assign(
  () => Object.assign(en.chat, enChatFileReferences.chat),
  { catalog: enChatFileReferences },
);
