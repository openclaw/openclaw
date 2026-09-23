import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  filePreview: {
    bundle: {
      binary: "This binary file is included in the bundle but cannot be displayed as text.",
      "too-large":
        "This file exceeds the preview limit. Its contents have not been truncated or loaded.",
      unavailable:
        "This file could not be read safely or is unavailable. Close and reopen the skill to try again.",
      incomplete: "Some bundle content is unavailable. Select a file to see its status.",
    },
    listLabel: "Files",
    searchPlaceholder: "Search files…",
    readOnly: "read-only",
    emptyTitle: "No files match",
    emptySubtitle: "Try another file name or content search.",
    copyFile: "Copy file",
    fileCount: "{count} files",
    filteredFileCount: "{count}/{total} files",
    noMatches: "No files match.",
    navigate: "navigate",
    kind: {
      text: "Text",
      shell: "Shell",
      file: "File",
    },
  },
} satisfies TranslationMap;

export const registerFilePreviewEnglish = Object.assign(
  () => {
    Object.assign(en.filePreview, catalog.filePreview);
  },
  { catalog },
);
