import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { type EditorId, openEditor } from "../../../lib/editor-links.ts";
import type { createAttachmentDownload } from "./chat-attachment-download.ts";
import type { createFileCopy } from "./chat-file-copy.ts";
import type { FileReadingMode, FileViewControls } from "./chat-file-reader-controls.ts";
import type { createFileHtmlPreview } from "./chat-html-preview.ts";
import type {
  FileSidebarNavigation,
  FileReaderInteraction,
  FileReaderViewRequest,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";
import {
  handleSidebarClick,
  handleSidebarKeydown,
  type SidebarPanelProps,
} from "./chat-sidebar-content.tsx";
import {
  computeFileMatches,
  loadFileWrapPreference,
  saveFileWrapPreference,
} from "./chat-sidebar-file-view.tsx";
import type { ChatDetailPanelProps } from "./chat-sidebar-view-types.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";

type FilePresentationState = {
  fileSearchOpen: boolean;
  fileWrap: boolean;
  fileReadingMode: FileReadingMode;
  fileWrapBeforeEdit: boolean | null;
  fileReadingModeBeforeEdit: FileReadingMode | null;
  fileReadingModeBeforeSearch: FileReadingMode | null;
  htmlPreviewBeforeSearch: boolean;
  htmlPreviewBeforeEdit: boolean;
  fileSearchQuery: string;
  fileSearchMatchIndex: number;
  fileEditorMenuOpen: boolean;
  searchInput?: HTMLInputElement;
  searchToggle?: HTMLButtonElement | (() => HTMLButtonElement | undefined);
};

export function createFilePresentationState(mobile: boolean): FilePresentationState {
  return {
    fileSearchOpen: false,
    fileWrap: mobile && loadFileWrapPreference(),
    fileReadingMode: "highlighted",
    fileWrapBeforeEdit: null,
    fileReadingModeBeforeEdit: null,
    fileReadingModeBeforeSearch: null,
    htmlPreviewBeforeSearch: false,
    htmlPreviewBeforeEdit: false,
    fileSearchQuery: "",
    fileSearchMatchIndex: 0,
    fileEditorMenuOpen: false,
  };
}

export function createFilePresentationActions(context: {
  props: ChatDetailPanelProps;
  presentation: FilePresentationState;
  htmlPreview: ReturnType<typeof createFileHtmlPreview>;
  interact: (interaction: FileReaderInteraction) => void;
  fileCopy: ReturnType<typeof createFileCopy>;
  content: () => ChatDetailPanelContent | null;
  editor: () => FileEditorViewHandle | null;
  editing: () => boolean;
  reloading: () => boolean;
  currentFileText: () => string;
  afterCommit: () => Promise<void>;
  isConnected: () => boolean;
  invalidate: () => void;
}) {
  const { presentation } = context;
  function fileSearchMatches(): number[] {
    const content = context.content();
    return content?.kind === "file"
      ? computeFileMatches(context.currentFileText(), presentation.fileSearchQuery)
      : [];
  }

  async function scrollToCurrentFileMatch() {
    await context.afterCommit();
    const line = fileSearchMatches()[presentation.fileSearchMatchIndex];
    if (line != null) {
      context.editor()?.scrollToLine(line, true);
    }
  }

  const toggleFileWrap = () => {
    presentation.fileWrap = !presentation.fileWrap;
    if (context.props.filePresentation === "mobile") {
      saveFileWrapPreference(presentation.fileWrap);
    }
    context.invalidate();
  };

  const closeFileSearch = (reason: "close" | "escape" | "outside") => {
    if (!presentation.fileSearchOpen) {
      return;
    }
    presentation.fileSearchOpen = false;
    presentation.fileSearchQuery = "";
    presentation.fileSearchMatchIndex = 0;
    presentation.fileReadingMode =
      presentation.fileReadingModeBeforeSearch ?? presentation.fileReadingMode;
    presentation.fileReadingModeBeforeSearch = null;
    if (presentation.htmlPreviewBeforeSearch && !context.htmlPreview.showing) {
      context.htmlPreview.toggle();
    }
    presentation.htmlPreviewBeforeSearch = false;
    context.invalidate();
    if (reason !== "outside") {
      void context.afterCommit().then(() => {
        if (!context.isConnected() || presentation.fileSearchOpen) {
          return;
        }
        const target =
          typeof presentation.searchToggle === "function"
            ? presentation.searchToggle()
            : presentation.searchToggle;
        target?.focus({ preventScroll: true });
      });
    }
  };

  const toggleFileSearch = () => {
    if (presentation.fileSearchOpen) {
      closeFileSearch("close");
      return;
    }
    presentation.htmlPreviewBeforeSearch = context.htmlPreview.showing;
    context.htmlPreview.showSource();
    presentation.fileReadingModeBeforeSearch = presentation.fileReadingMode;
    if (presentation.fileReadingMode === "preview") {
      presentation.fileReadingMode = "highlighted";
    }
    presentation.fileSearchOpen = true;
    presentation.fileEditorMenuOpen = false;
    context.invalidate();
    void context.afterCommit().then(() => {
      if (context.isConnected() && presentation.fileSearchOpen) {
        presentation.searchInput?.focus();
      }
    });
  };

  const updateFileSearch = (query: string) => {
    presentation.fileSearchQuery = query;
    presentation.fileSearchMatchIndex = 0;
    void scrollToCurrentFileMatch();
  };

  function moveFileSearch(offset: number) {
    const matches = fileSearchMatches();
    if (matches.length === 0) {
      return;
    }
    presentation.fileSearchMatchIndex =
      (presentation.fileSearchMatchIndex + offset + matches.length) % matches.length;
    void scrollToCurrentFileMatch();
  }

  const handleFileSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeFileSearch("escape");
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      moveFileSearch(event.shiftKey ? -1 : 1);
    }
  };

  const openInEditor = (editor: EditorId) => {
    const content = context.content();
    if (content?.kind !== "file") {
      return;
    }
    const absPath = localEditorFilePath(content, context.props.execNode);
    if (!absPath) {
      return;
    }
    presentation.fileEditorMenuOpen = false;
    openEditor(editor, absPath, context.props.fileNavigation?.line ?? content.line);
    context.invalidate();
  };

  const changeFileReadingMode = (mode: FileReadingMode) => {
    if (context.editing()) {
      return;
    }
    if (mode === "preview") {
      closeFileSearch("outside");
    }
    presentation.fileReadingMode = mode;
    context.invalidate();
  };

  const handlePanelClick = (event: MouseEvent) => {
    if (
      event.target instanceof Element &&
      event.target.closest("a[href], a[data-file-path], a[data-session-key], [data-session-href]")
    ) {
      context.interact("link");
    }
    handleSidebarClick(event, context.props);
  };

  const handlePanelKeyDown = (event: KeyboardEvent) => {
    if (
      (event.key === "Enter" || event.key === " ") &&
      event.target instanceof Element &&
      event.target.closest("a[data-file-path], a[data-session-key], [data-session-href]")
    ) {
      context.interact("link");
    }
    if (
      event.key.toLowerCase() === "c" &&
      event.shiftKey &&
      (event.metaKey || event.ctrlKey) &&
      context.content()?.kind === "file" &&
      !(
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
    ) {
      event.preventDefault();
      event.stopPropagation();
      context.interact("copy");
      context.fileCopy.copy("contents");
      return;
    }
    handleSidebarKeydown(event, context.props);
  };

  function resetFilePresentation(
    content: ChatDetailPanelContent | null,
    navigation: FileSidebarNavigation | null,
  ) {
    presentation.fileSearchOpen = false;
    presentation.fileSearchQuery = "";
    presentation.fileSearchMatchIndex = 0;
    presentation.fileWrap =
      context.props.filePresentation === "mobile"
        ? loadFileWrapPreference()
        : content?.kind === "file" &&
          !context.htmlPreview.file &&
          !/\.(?:md|markdown|mkd)$/i.test(content.name) &&
          content.mimeType !== "text/markdown" &&
          content.mimeType !== "image/svg+xml";
    presentation.fileWrapBeforeEdit = null;
    presentation.fileReadingMode =
      content?.kind === "file" &&
      navigation?.line == null &&
      content.line == null &&
      (/\.(?:md|markdown|mkd)$/i.test(content.name) ||
        content.mimeType === "text/markdown" ||
        (context.props.filePresentation !== "mobile" && content.mimeType === "image/svg+xml"))
        ? "preview"
        : "highlighted";
    presentation.fileReadingModeBeforeEdit = null;
    presentation.fileReadingModeBeforeSearch = null;
    presentation.htmlPreviewBeforeSearch = false;
    presentation.htmlPreviewBeforeEdit = false;
    presentation.fileEditorMenuOpen = false;
  }
  function beginEditPresentation() {
    presentation.htmlPreviewBeforeEdit = context.htmlPreview.showing;
    presentation.fileReadingModeBeforeEdit = presentation.fileReadingMode;
    if (context.props.filePresentation !== "mobile") {
      presentation.fileWrapBeforeEdit = presentation.fileWrap;
      presentation.fileWrap = false;
    }
    presentation.fileReadingMode =
      context.props.filePresentation === "mobile" ? "highlighted" : "plain";
  }
  function syncFileEditor() {
    const content = context.content();
    const editor = context.editor();
    if (content?.kind !== "file" || !editor) {
      return;
    }
    if (!context.editing()) {
      editor.setContent(content.content);
    }
    editor.setEditable(context.editing() && !context.reloading());
    editor.setLineWrapping(presentation.fileWrap);
    editor.setSyntaxHighlighting(presentation.fileReadingMode === "highlighted");
    editor.setScrollFades(context.props.filePresentation === "mobile");
    const matches = fileSearchMatches();
    editor.setDecorations({
      targetLine: context.props.fileNavigation?.line ?? content.line,
      matches,
      currentMatch: matches[presentation.fileSearchMatchIndex] ?? null,
    });
  }

  function restoreFileReadingPresentation() {
    presentation.fileReadingMode =
      presentation.fileReadingModeBeforeEdit ?? presentation.fileReadingMode;
    presentation.fileReadingModeBeforeEdit = null;
    presentation.fileWrap = presentation.fileWrapBeforeEdit ?? presentation.fileWrap;
    presentation.fileWrapBeforeEdit = null;
    if (presentation.htmlPreviewBeforeEdit && !context.htmlPreview.showing) {
      context.htmlPreview.toggle();
    }
    presentation.htmlPreviewBeforeEdit = false;
    if (presentation.fileReadingMode === "preview" || context.htmlPreview.showing) {
      presentation.fileSearchOpen = false;
      presentation.fileSearchQuery = "";
      presentation.fileSearchMatchIndex = 0;
      presentation.fileReadingModeBeforeSearch = null;
      presentation.htmlPreviewBeforeSearch = false;
    }
  }
  function showRequestedReadingMode(
    request: FileReaderViewRequest & { view: Exclude<FileReaderViewRequest["view"], "edit"> },
  ) {
    if (request.view === "reading") {
      if (context.htmlPreview.file) {
        closeFileSearch("outside");
        context.htmlPreview.showPreview();
      } else if (
        /\.(?:md|markdown|mkd)$/i.test(request.file.name) ||
        request.file.mimeType === "text/markdown"
      ) {
        changeFileReadingMode("preview");
      }
      return;
    }
    closeFileSearch("outside");
    changeFileReadingMode(request.view);
    context.htmlPreview.showSource();
  }
  return {
    syncFileEditor,
    restoreFileReadingPresentation,
    showRequestedReadingMode,
    handlePanelClick,
    handlePanelKeyDown,
    resetFilePresentation,
    beginEditPresentation,
    fileSearchMatches,
    closeFileSearch,
    toggleFileSearch,
    toggleFileWrap,
    updateFileSearch,
    moveFileSearch,
    handleFileSearchKeydown,
    openInEditor,
    changeFileReadingMode,
  };
}

export function renderFilePanelPresentation(context: {
  fileAttachment?: import("./chat-file-session-attachment.ts").FileSessionAttachment;
  props: ChatDetailPanelProps;
  presentation: FilePresentationState;
  htmlPreview: ReturnType<typeof createFileHtmlPreview>;
  fileCopy: ReturnType<typeof createFileCopy>;
  attachmentDownload: ReturnType<typeof createAttachmentDownload>;
  state: {
    visibleContent: ChatDetailPanelContent | null;
    error: Error | null;
    rawView: { file: import("./chat-sidebar-content-types.ts").FileSidebarContent | null } | null;
    fileSavedContent: string;
    fileDirty: boolean;
    fileEditing: boolean;
    fileEditorLoading: boolean;
    fileOperationVersion: number;
    fileSaveNotice: FileViewControls["saveNotice"];
    fileSaving: boolean;
  };
  setEditorMount: (element: HTMLElement) => void;
  actions: {
    fileSearchMatches: () => number[];
    currentFileText: () => string;
    retryFileEditor: () => void;
    toggleHtmlSource: () => void;
    closeFileSearch: NonNullable<FileViewControls["onCloseSearch"]>;
    interact: (
      interaction: import("./chat-sidebar-content-types.ts").FileReaderInteraction,
    ) => void;
    changeFileReadingMode: (mode: FileReadingMode) => void;
    discardFileEdits: () => void;
    editFile: () => Promise<void>;
    moveFileSearch: (offset: number) => void;
    openInEditor: (editor: EditorId) => void;
    overwriteFile: () => void;
    reloadFile: () => void;
    saveFile: () => Promise<boolean>;
    updateFileSearch: (query: string) => void;
    handleFileSearchKeydown: (event: KeyboardEvent) => void;
    toggleFileSearch: () => void;
    toggleFileWrap: () => void;
    close: () => void;
    showRawText: () => void;
    handlePanelClick: (event: MouseEvent) => void;
    handlePanelKeyDown: (event: KeyboardEvent) => void;
    invalidate: () => void;
  };
}): SidebarPanelProps {
  const content = context.props.content;
  const state = context.state;
  const { presentation } = context;
  const file = context.htmlPreview.file;
  const matches = context.actions.fileSearchMatches();
  const currentMatchIndex = matches.length
    ? Math.min(presentation.fileSearchMatchIndex, matches.length - 1)
    : 0;
  return {
    content: state.visibleContent,
    presentation: context.props.panelPresentation,
    active: context.props.panelActive,
    showingRawText: Boolean(state.rawView),
    error: file ? null : state.error,
    onRetry: context.actions.retryFileEditor,
    fileView: {
      fileAttachment: context.fileAttachment,
      htmlPreview: context.htmlPreview.controls({
        error: state.error,
        onRetry: context.actions.retryFileEditor,
        onToggle: context.actions.toggleHtmlSource,
        runtime: context.props.attachmentRuntime,
        mode: context.props.embedSandboxMode,
      }),
      presentation: context.props.filePresentation ?? "desktop",
      onScrollPortRef: context.props.onScrollPortRef,
      back: context.props.fileBack ?? undefined,
      active: context.props.filePresented !== false,
      workspace: context.props.fileWorkspace ?? undefined,
      onCloseSearch: context.actions.closeFileSearch,
      readingMode: presentation.fileReadingMode,
      imagePreview:
        context.props.filePresentation !== "mobile" &&
        content?.kind === "file" &&
        content.mimeType === "image/svg+xml"
          ? { content: state.fileSavedContent }
          : undefined,
      markdown:
        content?.kind === "file" &&
        (/\.(?:md|markdown|mkd)$/i.test(content.name) || content.mimeType === "text/markdown")
          ? {
              content: context.actions.currentFileText(),
              navigation: context.props.fileNavigation,
              options: {
                mode: "document",
                remoteImages: false,
                codeBlockInteraction: "interactive",
                fileLinks: true,
                fileLinkBasePath: content.absolutePath ?? content.path,
                sessionLinks: true,
                interactiveImages: context.props.onOpenImage !== null,
              },
            }
          : undefined,
      onSelectContent: () => context.actions.interact("selection"),
      onReadingModeChange: context.actions.changeFileReadingMode,
      copyFeedback: context.fileCopy.feedback(),
      editorRef: (element) => {
        context.setEditorMount(element);
      },
      searchInputRef: (element) => {
        presentation.searchInput = element;
      },
      searchToggleRef: (element) => {
        presentation.searchToggle = element;
      },
      currentMatchIndex,
      dirty: state.fileDirty,
      execNode: context.props.execNode,
      editorMenuOpen: presentation.fileEditorMenuOpen,
      editing: state.fileEditing,
      loadingEditor: state.fileEditorLoading,
      mountKey: state.fileOperationVersion,
      matches,
      query: presentation.fileSearchQuery,
      saveNotice: state.fileSaveNotice,
      get saving() {
        return state.fileSaving;
      },
      searchOpen: presentation.fileSearchOpen,
      wrap: presentation.fileWrap,
      onCopy: (action) => {
        context.actions.interact("copy");
        context.fileCopy.copy(action);
      },
      onDiscard: context.actions.discardFileEdits,
      onEdit: () => void context.actions.editFile(),
      onNextMatch: () => context.actions.moveFileSearch(1),
      onOpenEditor: context.actions.openInEditor,
      onOverwrite: context.actions.overwriteFile,
      onPreviousMatch: () => context.actions.moveFileSearch(-1),
      onReload: context.actions.reloadFile,
      onReveal: context.props.onRevealInWorkspace ?? undefined,
      onSave: () => void context.actions.saveFile(),
      onSearchInput: context.actions.updateFileSearch,
      onSearchKeydown: context.actions.handleFileSearchKeydown,
      onEditorMenuOpenChange: (open) => {
        presentation.fileEditorMenuOpen = open;
        context.actions.invalidate();
      },
      onToggleSearch: context.actions.toggleFileSearch,
      onToggleWrap: context.actions.toggleFileWrap,
    },
    canvasPluginSurfaceUrl: context.props.canvasPluginSurfaceUrl,
    embedSandboxMode: context.props.embedSandboxMode,
    allowExternalEmbedUrls: context.props.allowExternalEmbedUrls,
    embedded: context.props.embedded,
    filePresentation: context.props.filePresentation ?? "desktop",
    fileBack: context.props.fileBack ?? undefined,
    onClose: context.actions.close,
    onOpenImage: context.props.onOpenImage ?? undefined,
    onViewRawText: context.actions.showRawText,
    onClick: context.actions.handlePanelClick,
    onKeydown: context.actions.handlePanelKeyDown,
    attachmentRuntime: context.props.attachmentRuntime,
    attachmentDownload: context.attachmentDownload,
  };
}

export const chatDetailPanelProperties = {
  attachmentChat: { default: undefined, attribute: false },
  onScrollPortRef: { default: undefined, attribute: false },
  panelPresentation: { default: undefined, attribute: false },
  panelActive: { default: true, type: Boolean },
  filePresentation: { default: "desktop" },
  fileBack: { default: null, attribute: false },
  filePresented: { default: true, type: Boolean },
  fileWorkspace: { default: null, attribute: false },
  onFileInteraction: { default: null, attribute: false },
  onFileDraftChange: { default: null, attribute: false },
  content: { default: null, attribute: false },
  fileNavigation: { default: null, attribute: false },
  execNode: { default: null, attribute: false },
  attachmentRuntime: { default: {}, attribute: false },
  basePath: { default: "" },
  canvasPluginSurfaceUrl: { default: null },
  embedSandboxMode: { default: "scripts" },
  allowExternalEmbedUrls: { default: false },
  embedded: { default: false },
  onOpenWorkspaceFile: { default: null, attribute: false },
  onOpenSessionLink: { default: null, attribute: false },
  onRevealInWorkspace: { default: null, attribute: false },
  onOpenImage: { default: null, attribute: false },
} as const;
