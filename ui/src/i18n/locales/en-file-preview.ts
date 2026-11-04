import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const catalog = {
  chat: {
    detailPanel: {
      filePreviewUnavailable: "This file is not previewable inline.",
      filePreviewPath: "- Path: {path}",
      filePreviewType: "- Type: {type}",
      filePreviewSize: "- Size: {size}",
      filePreviewUpdated: "- Updated: {date}",
      sameOrigin: "File downloads require a same-origin Gateway connection.",
      invalidUrl: "Invalid file download URL",
      close: "Close sidebar",
      copyPath: "Copy path",
      copyRelativePath: "Copy relative path",
      downloadToView: "Download this file to view it on your device.",
      discard: "Discard",
      discardBody: "If you discard them, they’re lost.",
      editFile: "Edit file",
      downloadFile: "Download file",
      downloading: "Downloading…",
      downloadFailed: "Couldn’t download this file. Try again. {error}",
      searchInFile: "Search in file",
      showInFiles: "Show in Files",
      toggleTree: "Toggle file tree",
      unavailable: "Unable to open",
      attachmentOffline: "Reconnect, then open this attachment link again.",
      attachmentUnavailable:
        "This attachment is unavailable in this session. Ask the sender to share it again.",
      outsideSessionBoundary: "This file is outside {session}’s workspace, and you can’t open it.",
      assetsUnavailable: "Couldn’t load some assets ({count}). Try again.",
      cspPreviewUnsupported:
        "This security policy or resource setup does not support relative resources in Preview. Use Source or Download for the original file.",
      previousMatch: "Previous match",
      nextMatch: "Next match",
      overwrite: "Overwrite",
      viewRawText: "View raw text",
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
        copyFailed: "Couldn’t copy the edits. Select the text or download the draft instead.",
      },
      overwriteLoadFailed: "Failed to load the latest file before overwriting.",
      fullContentLoadFailed: "Couldn’t load the full file. Try again. {error}",
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
      binary: "This binary file is included in the bundle but can’t be displayed as text.",
      "too-large":
        "This file exceeds the preview limit. Its contents have not been truncated or loaded.",
      unavailable: "Couldn’t read this file safely. Close and reopen the skill to try again.",
      incomplete: "Some bundle content is unavailable. Select a file to see its status.",
    },
    listLabel: "Files",
    searchPlaceholder: "Search files…",
    readOnly: "read-only",
    emptyTitle: "No files match your search.",
    emptySubtitle: "Try another file name or content search.",
    copyFile: "Copy file",
    fileCount: "{count} files",
    filteredFileCount: "{count}/{total} files",
    noMatches: "No files match your search.",
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
