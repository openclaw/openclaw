import { toErrorObject } from "@openclaw/normalization-core";
import { createEffect, onCleanup } from "solid-js";
import { localEditorFilePath } from "../../../app/native-editor-locality.runtime.ts";
import { nativeGatewaysCapability } from "../../../app/native-gateways.runtime.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../../app/stale-chunk-reload.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { type EditorId, openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { SolidBridgeElement } from "../../../lit/solid-bridge.ts";
import { defineSolidBridge, LitContent } from "../../../lit/solid-bridge.ts";
import { createSolidRenderLifecycle } from "../solid-render-lifecycle.ts";
import { AttachmentDownloadController } from "./chat-attachment-download-controller.ts";
import { FileCopyController } from "./chat-file-copy-controller.ts";
import { captureFileEditorDraft, restoreFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import { FileHtmlPreviewController } from "./chat-html-preview.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import type {
  ChatDetailPanelProps,
  FileSidebarNavigation,
  AttachmentSidebarRuntime,
  FileSidebarContent,
  ChatDetailPanelContent,
} from "./chat-sidebar-content-types.ts";
import {
  buildRawContent,
  handleSidebarClick,
  handleSidebarKeydown,
  renderSidebarPanel,
} from "./chat-sidebar-content.ts";
import {
  computeFileMatches,
  loadFileWrapPreference,
  saveFileWrapPreference,
} from "./chat-sidebar-file-view.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";

registerEnglishCatalog(registerFilePreviewEnglish);

export type ChatDetailPanel = SolidBridgeElement<ChatDetailPanelProps>;

function DetailPanel(props: ChatDetailPanelProps, host: SolidBridgeElement<ChatDetailPanelProps>) {
  let disposed = false;
  let invalidateRender = () => {};
  const invalidate = () => invalidateRender();
  const afterCommit = () =>
    new Promise<void>((resolve) => {
      lifecycle.afterCommit(() => resolve(), resolve);
    });
  const updatingHost = {
    get isConnected() {
      return !disposed && host.isConnected;
    },
    requestUpdate: invalidate,
    get updateComplete() {
      return afterCommit();
    },
  };
  let visibleContent: ChatDetailPanelContent | null = null;
  let error: Error | null = null;
  let fileSearchOpen = false;
  let fileWrap = loadFileWrapPreference();
  let fileSearchQuery = "";
  let fileSearchMatchIndex = 0;
  let fileEditorMenuOpen = false;
  const fileCopy = new FileCopyController(updatingHost, () => visibleContent);
  let fileEditorLoading = false;
  let fileEditing = false;
  let fileDirty = false;
  let fileReloading = false;
  let fileSaving = false;
  let fileSaveNotice: { kind: "conflict" } | { kind: "error"; message: string } | null = null;

  const htmlPreview = new FileHtmlPreviewController(
    updatingHost,
    () => visibleContent,
    () => currentFileText(),
  );

  let fileOperationVersion = 0;
  let rawView: { file: FileSidebarContent | null } | null = null;
  let fileEditor: FileEditorViewHandle | null = null;
  let fileEditorLoad: Promise<void> | null = null;
  let fileDraftContent: string | null = null;
  let fileSavedContent = "";
  let fileHash = "";
  const attachmentDownload = new AttachmentDownloadController(
    updatingHost,
    () => (props.content === visibleContent ? props.content : null),
    () => props.attachmentRuntime,
  );

  function updateSelection(
    contentChanged: boolean,
    navigationChanged: boolean,
    previousRuntime: AttachmentSidebarRuntime | undefined,
    content: ChatDetailPanelContent | null,
    navigation: FileSidebarNavigation | null,
    runtime: AttachmentSidebarRuntime,
  ) {
    if (previousRuntime && previousRuntime.connectionEpoch !== runtime.connectionEpoch) {
      releaseChatMediaResourceSubscriber(invalidate);
      attachmentDownload.cancel();
    }
    if (navigationChanged && navigation && content?.kind === "file") {
      htmlPreview.showSource();
    }
    if (!contentChanged) {
      // A line link is navigation, not replacement content: keep drafts, undo,
      // save operations, and the mounted editor intact. Plain tab selection
      // does not change this request and must not reset raw view or scroll.
      if (navigationChanged && navigation && content?.kind === "file" && rawView) {
        visibleContent = rawView.file ?? content;
        rawView = null;
      }
      return;
    }
    releaseChatMediaResourceSubscriber(invalidate);
    attachmentDownload.cancel();
    visibleContent = content;
    error = null;
    rawView = null;
    fileSearchOpen = false;
    fileSearchQuery = "";
    fileSearchMatchIndex = 0;
    fileEditorMenuOpen = false;
    fileCopy.reset();
    fileOperationVersion += 1;
    fileReloading = false;
    fileSaving = false;
    fileSaveNotice = null;
    const restoredDraft = restoreFileDraft(content?.kind === "file" ? content : null);
    fileDraftContent = restoredDraft?.content ?? null;
    fileSavedContent = content?.kind === "file" ? content.content : "";
    fileHash =
      restoredDraft?.expectedHash ?? (content?.kind === "file" ? (content.edit?.hash ?? "") : "");
    fileEditing = Boolean(restoredDraft);
    fileDirty = Boolean(restoredDraft);
    htmlPreview.reset(
      fileDraftContent,
      Boolean(navigation || (content?.kind === "file" && content.line != null)),
    );
    fileEditorLoading = content?.kind === "file" && !htmlPreview.showing;
    destroyFileEditor();
  }

  function updateEditor(navigate: boolean) {
    const content = visibleContent;
    if (content?.kind === "file" && !rawView && !htmlPreview.showing && !error) {
      void ensureFileEditor().then(() => {
        syncFileEditor();
        if (navigate && (props.fileNavigation?.line ?? content.line) != null) {
          scrollToFileLine(content);
        }
      });
    }
  }

  function currentFileText(): string {
    return (
      fileEditor?.getContent() ??
      fileDraftContent ??
      (visibleContent?.kind === "file" ? visibleContent.content : "")
    );
  }

  const toggleHtmlSource = () => {
    fileSearchOpen = false;
    htmlPreview.toggle();
  };

  function scrollToFileLine(content: FileSidebarContent) {
    const line = props.fileNavigation?.line ?? content.line;
    if (visibleContent === content && !rawView && line != null) {
      fileEditor?.scrollToLine(line, true);
    }
  }

  function destroyFileEditor() {
    fileOperationVersion += 1;
    fileEditor?.destroy();
    fileEditor = null;
    fileEditorLoad = null;
  }

  function ensureFileEditor(): Promise<void> {
    if (fileEditor) {
      return Promise.resolve();
    }
    if (fileEditorLoad) {
      return fileEditorLoad;
    }
    const content = visibleContent;
    const parent = host.querySelector<HTMLElement>(".file-view__mount");
    if (content?.kind !== "file" || !parent || htmlPreview.showing) {
      return Promise.resolve();
    }
    const version = fileOperationVersion;
    fileEditorLoading = true;
    invalidate();
    fileEditorLoad = import("./file-editor-view.ts")
      .then(async ({ createFileEditorView }) => {
        const current = visibleContent;
        if (version !== fileOperationVersion || current?.kind !== "file") {
          return;
        }
        const editor = await createFileEditorView({
          parent,
          content: fileDraftContent ?? current.content,
          name: current.name,
          editable: fileEditing,
          wrap: fileWrap,
          onSave: saveFile,
        });
        if (
          version !== fileOperationVersion ||
          !updatingHost.isConnected ||
          visibleContent?.kind !== "file"
        ) {
          editor.destroy();
          return;
        }
        // Reload may settle while the editor awaits its language support.
        editor.setContent(currentFileText());
        fileEditor = editor;
        fileDraftContent = null;
        editor.onDocChanged((nextContent) => {
          const draft = captureFileEditorDraft(current, {
            // Reload synchronization may normalize display text without a user edit.
            editing: fileEditing && !fileReloading,
            content: nextContent,
            dirty: !editor.contentEquals(fileSavedContent),
            expectedHash: fileHash,
          });
          if (!draft) {
            return;
          }
          fileDirty = draft.dirty;
          fileHash = draft.expectedHash;
          if (fileSaveNotice?.kind === "error") {
            fileSaveNotice = null;
          }
          invalidate();
        });
      })
      .catch((cause: unknown) => {
        if (version !== fileOperationVersion || !updatingHost.isConnected) {
          return;
        }
        // A failed load is terminal for this selection; renders must not retry it.
        error = toErrorObject(cause, t("lazyView.errorTitle"));
        if (isStaleChunkImportError(error)) {
          void scheduleStaleChunkReload();
        }
      })
      .finally(() => {
        if (version === fileOperationVersion) {
          fileEditorLoad = null;
          fileEditorLoading = false;
          invalidate();
        }
      });
    return fileEditorLoad;
  }

  const retryFileEditor = () => {
    const failedError = error;
    const version = fileOperationVersion;
    if (isStaleChunkImportError(failedError)) {
      void retryStaleChunkReloadWhenReachable({
        canReload: () =>
          updatingHost.isConnected && error === failedError && version === fileOperationVersion,
      });
    } else {
      error = null;
      invalidate();
    }
  };

  function syncFileEditor() {
    const content = visibleContent;
    const editor = fileEditor;
    if (content?.kind !== "file" || !editor) {
      return;
    }
    if (!fileEditing) {
      editor.setContent(content.content);
    }
    editor.setEditable(fileEditing && !fileReloading);
    editor.setLineWrapping(fileWrap);
    const matches = fileSearchMatches();
    editor.setDecorations({
      targetLine: props.fileNavigation?.line ?? content.line,
      matches,
      currentMatch: matches[fileSearchMatchIndex] ?? null,
    });
  }

  const handleDocumentPointerDown = (event: PointerEvent) => {
    if (!fileEditorMenuOpen) {
      return;
    }
    const editor = host.querySelector(".sidebar-file-view__editor");
    if (!editor || !event.composedPath().includes(editor)) {
      fileEditorMenuOpen = false;
      invalidate();
    }
  };

  function fileSearchMatches(): number[] {
    const content = visibleContent;
    return content?.kind === "file" ? computeFileMatches(content.content, fileSearchQuery) : [];
  }

  async function scrollToCurrentFileMatch() {
    await afterCommit();
    const line = fileSearchMatches()[fileSearchMatchIndex];
    if (line != null) {
      fileEditor?.scrollToLine(line, true);
    }
  }

  const toggleFileWrap = () => {
    fileWrap = !fileWrap;
    saveFileWrapPreference(fileWrap);
    invalidate();
  };

  const toggleFileSearch = () => {
    htmlPreview.showSource();
    fileSearchOpen = !fileSearchOpen;
    fileEditorMenuOpen = false;
    invalidate();
    if (!fileSearchOpen) {
      fileSearchQuery = "";
      fileSearchMatchIndex = 0;
      return;
    }
    void afterCommit().then(() => {
      host.querySelector<HTMLInputElement>(".file-view__search input")?.focus();
    });
  };

  const updateFileSearch = (query: string) => {
    fileSearchQuery = query;
    fileSearchMatchIndex = 0;
    void scrollToCurrentFileMatch();
  };

  function moveFileSearch(offset: number) {
    const matches = fileSearchMatches();
    if (matches.length === 0) {
      return;
    }
    fileSearchMatchIndex = (fileSearchMatchIndex + offset + matches.length) % matches.length;
    void scrollToCurrentFileMatch();
  }

  const handleFileSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      toggleFileSearch();
      host.querySelector<HTMLButtonElement>(".sidebar-file-view__search-toggle")?.focus({
        preventScroll: true,
      });
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      moveFileSearch(event.shiftKey ? -1 : 1);
    }
  };

  const openInEditor = (editor: EditorId) => {
    const content = visibleContent;
    if (content?.kind !== "file") {
      return;
    }
    const absPath = localEditorFilePath(content, props.execNode);
    if (!absPath) {
      return;
    }
    fileEditorMenuOpen = false;
    openEditor(editor, absPath, props.fileNavigation?.line ?? content.line);
    invalidate();
  };

  const editFile = async () => {
    const content = visibleContent;
    if (content?.kind !== "file" || !content.edit) {
      return;
    }
    htmlPreview.showSource();
    await afterCommit();
    await ensureFileEditor();
    if (visibleContent !== content || !fileEditor) {
      return;
    }
    if (fileEditing) {
      fileEditor.focus();
      return;
    }
    fileSavedContent = content.content;
    fileHash = content.edit.hash;
    fileDirty = false;
    fileSaveNotice = null;
    fileSearchOpen = false;
    fileSearchQuery = "";
    fileSearchMatchIndex = 0;
    fileEditorMenuOpen = false;
    fileEditing = true;
    fileEditor.setEditable(true);
    void afterCommit().then(() => fileEditor?.focus());
  };

  const discardFileEdits = () => {
    if (!fileEditing || fileSaving) {
      return;
    }
    fileEditor?.setContent(fileSavedContent);
    fileDraftContent = null;
    htmlPreview.discard(fileSavedContent);
    const content = visibleContent;
    if (content?.kind === "file") {
      setFileDraft(content, null);
      fileHash = content.edit?.hash ?? "";
    }
    fileDirty = false;
    fileSaveNotice = null;
    fileEditing = false;
    fileEditor?.setEditable(false);
    invalidate();
  };

  function updateSavedFile(content: FileSidebarContent, nextContent: string, hash: string) {
    const draftContent = currentFileText();
    fileSavedContent = nextContent;
    fileHash = hash;
    fileDirty = !(fileEditor?.contentEquals(nextContent) ?? draftContent === nextContent);
    fileDraftContent = !fileEditor && fileDirty ? draftContent : null;
    setFileDraft(content, fileDirty ? { content: draftContent, expectedHash: hash } : null);
    fileSaveNotice = null;
    // The retained file tab owns the saved buffer used by later reads and opens.
    content.content = nextContent;
    content.rawText = nextContent;
    if (content.edit) {
      content.edit.hash = hash;
    }
  }

  async function saveFileContent(
    content: FileSidebarContent,
    nextContent: string,
    expectedHash: string,
    version: number,
  ) {
    if (!content.edit) {
      return;
    }
    const outcome = await content.edit.save({ content: nextContent, expectedHash });
    if (version !== fileOperationVersion || visibleContent?.kind !== "file") {
      return;
    }
    if (outcome.ok) {
      updateSavedFile(visibleContent, nextContent, outcome.hash);
    } else if (outcome.code === "conflict") {
      fileSaveNotice = { kind: "conflict" };
    } else {
      fileSaveNotice = { kind: "error", message: outcome.message };
    }
  }

  const saveFile = () => {
    const content = visibleContent;
    if (content?.kind !== "file" || !content.edit || !fileEditing || !fileDirty || fileSaving) {
      return;
    }
    const version = fileOperationVersion;
    fileSaving = true;
    fileSaveNotice = null;
    invalidate();
    trackFileOperation(saveFileContent(content, currentFileText(), fileHash, version), version);
  };

  const reloadFile = () => startLatestFileOperation("reload");

  const overwriteFile = () => startLatestFileOperation("overwrite");

  function startLatestFileOperation(action: "reload" | "overwrite"): void {
    const content = visibleContent;
    if (content?.kind !== "file" || !content.edit || fileSaving) {
      return;
    }
    const version = fileOperationVersion;
    let onLatest: (
      latest: Awaited<ReturnType<NonNullable<FileSidebarContent["edit"]>["fetchLatest"]>>,
    ) => void | Promise<void>;
    if (action === "reload") {
      fileSaving = true;
      fileReloading = true;
      fileEditor?.setEditable(false);
      onLatest = (latest) => {
        if (version !== fileOperationVersion || visibleContent?.kind !== "file") {
          return;
        }
        if (!latest) {
          fileSaveNotice = {
            kind: "error",
            message: t("chat.detailPanel.reloadFailed"),
          };
          return;
        }
        fileEditor?.setContent(latest.content);
        fileDraftContent = fileEditor ? null : latest.content;
        htmlPreview.discard(latest.content);
        updateSavedFile(visibleContent, latest.content, latest.hash);
        // A reload can bring back content that no longer qualifies for edit
        // mode (e.g. the agent rewrote the file with mixed line endings);
        // drop the edit capability instead of letting a save corrupt it.
        if (!latest.editable && visibleContent?.kind === "file") {
          setFileDraft(visibleContent, null);
          fileEditing = false;
          fileDirty = false;
          const { edit: _removed, ...readOnly } = visibleContent;
          visibleContent = readOnly;
        }
      };
    } else {
      // Overwrite deliberately replaces whatever is on disk (even content that
      // would fail the edit gates) with the local editor text the user chose.
      const localContent = currentFileText();
      fileSaving = true;
      onLatest = async (latest) => {
        if (version !== fileOperationVersion) {
          return;
        }
        if (!latest) {
          fileSaveNotice = {
            kind: "error",
            message: t("chat.detailPanel.overwriteLoadFailed"),
          };
          return;
        }
        await saveFileContent(content, localContent, latest.hash, version);
      };
    }
    invalidate();
    trackFileOperation(content.edit.fetchLatest().then(onLatest), version);
  }

  function trackFileOperation(operation: Promise<unknown>, version: number) {
    void operation
      .catch((cause: unknown) => {
        if (version === fileOperationVersion) {
          fileSaveNotice = { kind: "error", message: formatUiError(cause) };
        }
      })
      .finally(() => {
        if (version === fileOperationVersion) {
          fileSaving = false;
          if (fileReloading) {
            fileReloading = false;
            fileEditor?.setEditable(fileEditing);
          }
          invalidate();
        }
      });
  }

  const close = () => {
    host.dispatchEvent(new CustomEvent("chat-detail-panel-close", { bubbles: true }));
  };

  const showRawText = () => {
    if (htmlPreview.file) {
      htmlPreview.showSource();
      return;
    }
    const rawContent = buildRawContent(visibleContent);
    if (!rawContent) {
      return;
    }
    rawView = { file: visibleContent?.kind === "file" ? visibleContent : null };
    destroyFileEditor();
    visibleContent = rawContent;
    error = null;
    invalidate();
  };

  const handlePanelClick = (event: MouseEvent) => handleSidebarClick(event, props);

  const handlePanelKeyDown = (event: KeyboardEvent) => handleSidebarKeydown(event, props);

  let previousContent: ChatDetailPanelContent | null | undefined;
  let previousNavigation: FileSidebarNavigation | null | undefined;
  let previousRuntime: AttachmentSidebarRuntime | undefined;
  let navigate = false;
  function renderPanel() {
    const content = props.content;
    const navigation = props.fileNavigation;
    const runtime = props.attachmentRuntime;
    const contentChanged = content !== previousContent;
    const navigationChanged = navigation !== previousNavigation;
    if (contentChanged || navigationChanged || runtime !== previousRuntime) {
      navigate ||= contentChanged || navigationChanged;
      updateSelection(
        contentChanged,
        navigationChanged,
        previousRuntime,
        content,
        navigation,
        runtime,
      );
      previousContent = content;
      previousNavigation = navigation;
      previousRuntime = runtime;
    }

    // The retained Lit render helpers do not subscribe to Solid's locale projection yet.
    t("common.loading");
    const file = htmlPreview.file;
    const matches = fileSearchMatches();
    const currentMatchIndex = matches.length
      ? Math.min(fileSearchMatchIndex, matches.length - 1)
      : 0;
    return renderSidebarPanel({
      content: visibleContent,
      showingRawText: Boolean(rawView),
      error: file ? null : error,
      onRetry: retryFileEditor,
      fileView: {
        htmlPreview: htmlPreview.controls({
          error,
          onRetry: retryFileEditor,
          onToggle: toggleHtmlSource,
          runtime: props.attachmentRuntime,
          mode: props.embedSandboxMode,
        }),
        copyFeedback: fileCopy.feedback,
        currentMatchIndex,
        dirty: fileDirty,
        execNode: props.execNode,
        editorMenuOpen: fileEditorMenuOpen,
        editing: fileEditing,
        loadingEditor: fileEditorLoading,
        mountKey: fileOperationVersion,
        matches,
        query: fileSearchQuery,
        saveNotice: fileSaveNotice,
        saving: fileSaving,
        searchOpen: fileSearchOpen,
        wrap: fileWrap,
        onCopy: fileCopy.copy,
        onDiscard: discardFileEdits,
        onEdit: () => void editFile(),
        onNextMatch: () => moveFileSearch(1),
        onOpenEditor: openInEditor,
        onOverwrite: overwriteFile,
        onPreviousMatch: () => moveFileSearch(-1),
        onReload: reloadFile,
        onReveal: props.onRevealInWorkspace ?? undefined,
        onSave: saveFile,
        onSearchInput: updateFileSearch,
        onSearchKeydown: handleFileSearchKeydown,
        onEditorMenuOpenChange: (open) => {
          fileEditorMenuOpen = open;
          invalidate();
        },
        onToggleSearch: toggleFileSearch,
        onToggleWrap: toggleFileWrap,
      },
      canvasPluginSurfaceUrl: props.canvasPluginSurfaceUrl,
      embedSandboxMode: props.embedSandboxMode,
      allowExternalEmbedUrls: props.allowExternalEmbedUrls,
      ...props.githubContext,
      embedded: props.embedded,
      onClose: close,
      onOpenImage: props.onOpenImage ?? undefined,
      onViewRawText: showRawText,
      onClick: handlePanelClick,
      onKeydown: handlePanelKeyDown,
      onAttachmentUpdate: invalidate,
      attachmentRuntime: props.attachmentRuntime,
      attachmentDownload,
    });
  }

  const lifecycle = createSolidRenderLifecycle({
    host,
    presented: () => true,
    read: renderPanel,
  });
  invalidateRender = () => lifecycle.invalidate();
  createEffect(
    () => lifecycle.snapshot(),
    () => {
      const scrollToNavigation = navigate;
      navigate = false;
      // LitContent commits in its own effect; mount CodeMirror after that effect finishes.
      queueMicrotask(() => {
        if (!disposed) {
          updateEditor(scrollToNavigation);
        }
      });
    },
  );
  const unsubscribeNativeGateway = nativeGatewaysCapability()?.subscribe(invalidate);
  document.addEventListener("pointerdown", handleDocumentPointerDown);
  onCleanup(() => {
    disposed = true;
    unsubscribeNativeGateway?.();
    attachmentDownload.cancel();
    fileCopy.dispose();
    htmlPreview.dispose();
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    if (fileDirty) {
      fileDraftContent = currentFileText();
    }
    destroyFileEditor();
    releaseChatMediaResourceSubscriber(invalidate);
  });
  return <LitContent render={() => lifecycle.snapshot()} />;
}

export const ChatDetailPanel = defineSolidBridge("openclaw-chat-detail-panel", DetailPanel, {
  properties: {
    content: { default: null, attribute: false },
    fileNavigation: { default: null, attribute: false },
    execNode: { default: null, attribute: false },
    attachmentRuntime: { default: {}, attribute: false },
    basePath: { default: "" },
    canvasPluginSurfaceUrl: { default: null },
    embedSandboxMode: { default: "scripts" },
    allowExternalEmbedUrls: { default: false },
    githubContext: { default: {}, attribute: false },
    embedded: { default: false },
    onOpenWorkspaceFile: { default: null, attribute: false },
    onOpenSessionLink: { default: null, attribute: false },
    onRevealInWorkspace: { default: null, attribute: false },
    onOpenImage: { default: null, attribute: false },
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-detail-panel": ChatDetailPanel;
  }
}
