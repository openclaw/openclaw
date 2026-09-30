import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    detailPanel: {
      close: "Close sidebar",
      copyPath: "Copy path",
      discard: "Discard",
      editFile: "Edit file",
      searchInFile: "Search in file",
      showInFiles: "Show in Files",
      unavailable: "Unable to open",
      previousMatch: "Previous match",
      nextMatch: "Next match",
      overwrite: "Overwrite",
      viewRawText: "View Raw Text",
      viewSource: "Source",
      renderedMarkdown: "Rendered Markdown",
      renderedMarkdownHint: "Sanitized rich-text preview for quick reading.",
      noPreviewableMarkdown: "No previewable markdown content.",
      noContent: "No content available",
      fullContentOversized:
        "Full content is unavailable because the stored transcript entry is too large to return safely.",
      fullContentNotVisible:
        "Full content is unavailable because this transcript entry does not have a visible WebChat projection.",
      fullContentUnavailable: "Full content is no longer available for this transcript entry.",
      copyContents: "Copy file contents",
      fileChanged: "File changed on disk since it was loaded.",
      renderPreview: "Render preview",
      imagePreview: "Image preview",
      file: "File",
      markdownPreview: "Markdown preview",
      toolDetails: "Tool details",
      reloadFailed: "Failed to reload the latest file.",
      reloadBlocked: "Save or discard your file edits before reloading.",
      draftRecovery: {
        review: "Review file drafts",
        description:
          "Copy or download unsaved edits before discarding them. This only changes drafts in this tab, not files on disk. After resolving all drafts, try Refresh again.",
        copy: "Copy {name}",
        download: "Download {name}",
        discard: "Discard {name}",
        keep: "Keep drafts",
        changed: "These edits changed. Close this dialog and review the drafts again.",
        copyFailed: "Could not copy the edits. Select the text or download the draft instead.",
      },
      overwriteLoadFailed: "Failed to load the latest file before overwriting.",
      fullContentLoadFailed: "Failed to load full content: {error}",
    },
  },
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
    Object.assign(en.chat.detailPanel, catalog.chat.detailPanel);
    Object.assign(en.filePreview, catalog.filePreview);
  },
  { catalog },
);
