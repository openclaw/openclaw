import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    detailPanel: {
      close: "Close sidebar",
      copyPath: "Copy path",
      copyRelativePath: "Copy relative path",
      downloadToView: "Download this file to view it on your device.",
      discard: "Discard",
      editFile: "Edit file",
      downloadFile: "Download file",
      downloading: "Downloading…",
      downloadFailed: "Could not download this file: {error}. Try again.",
      searchInFile: "Search in file",
      showInFiles: "Show in Files",
      toggleTree: "Toggle file tree",
      unavailable: "Unable to open",
      attachmentOffline: "You're offline. Reconnect, then open this attachment link again.",
      attachmentUnavailable:
        "This attachment is unavailable in this chat. Ask the sender to share it again.",
      outsideSessionBoundary: "This file is outside {session}'s workspace, and you can't open it.",
      assetsUnavailable: "Some assets couldn't be loaded ({count})",
      cspPreviewUnsupported:
        "This security policy or resource setup does not support relative resources in Preview. Use Source or Download for the original file.",
      previousMatch: "Previous match",
      nextMatch: "Next match",
      overwrite: "Overwrite",
      viewRawText: "View Raw Text",
      viewSource: "Source",
      preview: "Preview",
      highlightedSource: "Highlighted source",
      plainSource: "Plain source",
      readingMode: "Reading mode",
      syntaxHighlighting: "Syntax highlighting",
      wrapLines: "Wrap lines",
      attachToSession: "Attach to session",
      fileActions: "File actions",
      moreFileActions: "More file actions",
      openInEditor: "Open in editor",
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
    skill: {
      title: "Skill file preview",
      source: "Skill source",
      open: "Open full file",
      loading: "Loading skill file…",
      unavailable: "Skill file unavailable",
      unavailableHint: "The skill may have moved or is not installed for this agent.",
      lines: "L1–{count} / {total}",
    },
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
