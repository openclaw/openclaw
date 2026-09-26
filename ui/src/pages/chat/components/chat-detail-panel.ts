import { toErrorObject } from "@openclaw/normalization-core";
import { property, state } from "lit/decorators.js";
import {
  localEditorFilePath,
  observeNativeGateway,
} from "../../../app/native-editor-locality.runtime.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../../app/stale-chunk-reload.ts";
import type { ImageLightboxItem } from "../../../components/image-lightbox.types.ts";
import type { MarkdownGitHubContext } from "../../../components/markdown-render-options.ts";
import type { SessionLinkTarget } from "../../../components/markdown-session-links.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { type EditorId, openEditor } from "../../../lib/editor-links.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { AttachmentDownloadController } from "./chat-attachment-download-controller.ts";
import { FileCopyController } from "./chat-file-copy-controller.ts";
import { captureFileEditorDraft, readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import { FileHtmlPreviewController } from "./chat-html-preview.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";
import type {
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

registerFilePreviewEnglish();

class ChatDetailPanel extends OpenClawLightDomElement {
  @property({ attribute: false }) content: ChatDetailPanelContent | null = null;
  @property({ attribute: false }) fileNavigation: FileSidebarNavigation | null = null;
  @property({ attribute: false }) execNode: string | null = null;
  @property({ attribute: false }) attachmentRuntime: AttachmentSidebarRuntime = {};
  @property() basePath = "";
  @property() canvasPluginSurfaceUrl: string | null = null;
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property({ type: Boolean }) allowExternalEmbedUrls = false;
  @property({ attribute: false }) githubContext: MarkdownGitHubContext = {};
  @property({ type: Boolean }) embedded = false;
  @property({ attribute: false }) onOpenWorkspaceFile?:
    | ((target: { path: string; line?: number | null }) => void)
    | null = null;
  @property({ attribute: false }) onOpenSessionLink?: ((target: SessionLinkTarget) => void) | null =
    null;
  @property({ attribute: false }) onRevealInWorkspace?: ((path: string) => void) | null = null;
  @property({ attribute: false }) onOpenImage?: ((item: ImageLightboxItem) => void) | null = null;

  @state() private visibleContent: ChatDetailPanelContent | null = null;
  @state() private error: Error | null = null;
  @state() private fileSearchOpen = false;
  @state() private fileWrap = loadFileWrapPreference();
  @state() private fileSearchQuery = "";
  @state() private fileSearchMatchIndex = 0;
  @state() private fileEditorMenuOpen = false;
  private readonly fileCopy = new FileCopyController(this, () => this.visibleContent);
  @state() private fileEditorLoading = false;
  @state() private fileEditing = false;
  @state() private fileDirty = false;
  @state() private fileReloading = false;
  @state() private fileSaving = false;
  @state() private fileSaveNotice:
    | { kind: "conflict" }
    | { kind: "error"; message: string }
    | null = null;

  private readonly htmlPreview = new FileHtmlPreviewController(
    this,
    () => this.visibleContent,
    () => this.currentFileText(),
  );

  private fileOperationVersion = 0;
  private showingRawText = false;
  private rawFileContent: FileSidebarContent | null = null;
  private fileEditor: FileEditorViewHandle | null = null;
  private fileEditorLoad: Promise<void> | null = null;
  private fileDraftContent: string | null = null;
  private fileSavedContent = "";
  private fileHash = "";
  private readonly requestAttachmentUpdate = () => this.requestUpdate();
  private readonly attachmentDownload = new AttachmentDownloadController(
    this,
    () => (this.content === this.visibleContent ? this.content : null),
    () => this.attachmentRuntime,
  );

  constructor() {
    super();
    observeNativeGateway(this);
  }

  override connectedCallback() {
    super.connectedCallback();
    document.addEventListener("pointerdown", this.handleDocumentPointerDown);
  }

  override disconnectedCallback() {
    this.attachmentDownload.cancel();
    document.removeEventListener("pointerdown", this.handleDocumentPointerDown);
    if (this.fileDirty) {
      this.fileDraftContent = this.currentFileText();
    }
    this.destroyFileEditor();
    releaseChatMediaResourceSubscriber(this.requestAttachmentUpdate);
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: Map<string, unknown>) {
    const previousRuntime = changed.get("attachmentRuntime");
    if (
      previousRuntime &&
      typeof previousRuntime === "object" &&
      "connectionEpoch" in previousRuntime &&
      previousRuntime.connectionEpoch !== this.attachmentRuntime.connectionEpoch
    ) {
      releaseChatMediaResourceSubscriber(this.requestAttachmentUpdate);
      this.attachmentDownload.cancel();
    }
    if (changed.has("fileNavigation") && this.fileNavigation && this.content?.kind === "file") {
      this.htmlPreview.showSource();
    }
    if (!changed.has("content")) {
      // A line link is navigation, not replacement content: keep drafts, undo,
      // save operations, and the mounted editor intact. Plain tab selection
      // does not change this request and must not reset raw view or scroll.
      if (
        changed.has("fileNavigation") &&
        this.fileNavigation &&
        this.content?.kind === "file" &&
        this.showingRawText
      ) {
        this.showingRawText = false;
        this.visibleContent = this.rawFileContent ?? this.content;
        this.rawFileContent = null;
      }
      return;
    }
    releaseChatMediaResourceSubscriber(this.requestAttachmentUpdate);
    this.attachmentDownload.cancel();
    this.visibleContent = this.content;
    this.error = null;
    this.showingRawText = false;
    this.rawFileContent = null;
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileSearchMatchIndex = 0;
    this.fileEditorMenuOpen = false;
    this.fileCopy.reset();
    this.fileOperationVersion += 1;
    this.fileEditing = false;
    this.fileDirty = false;
    this.fileReloading = false;
    this.fileSaving = false;
    this.fileSaveNotice = null;
    const retainedDraft =
      this.content?.kind === "file" && this.content.edit ? readFileDraft(this.content) : undefined;
    const restoredDraft =
      this.content?.kind === "file" && retainedDraft?.content !== this.content.content
        ? retainedDraft
        : undefined;
    if (retainedDraft && !restoredDraft && this.content?.kind === "file") {
      setFileDraft(this.content, null);
    }
    this.fileDraftContent = restoredDraft?.content ?? null;
    this.fileSavedContent = this.content?.kind === "file" ? this.content.content : "";
    this.fileHash =
      restoredDraft?.expectedHash ??
      (this.content?.kind === "file" ? (this.content.edit?.hash ?? "") : "");
    this.fileEditing = Boolean(restoredDraft);
    this.fileDirty = Boolean(restoredDraft);
    this.htmlPreview.reset(
      this.fileDraftContent,
      Boolean(this.fileNavigation || (this.content?.kind === "file" && this.content.line != null)),
    );
    this.fileEditorLoading = this.content?.kind === "file" && !this.htmlPreview.showing;
    this.destroyFileEditor();
  }

  protected override updated(changed: Map<string, unknown>) {
    const visibleContent = this.visibleContent;
    if (
      visibleContent?.kind === "file" &&
      !this.showingRawText &&
      !this.htmlPreview.showing &&
      !this.error
    ) {
      void this.ensureFileEditor().then(() => {
        this.syncFileEditor();
        if (
          (changed.has("content") || changed.has("fileNavigation")) &&
          (this.fileNavigation?.line ?? visibleContent.line) != null
        ) {
          this.scrollToFileLine(visibleContent);
        }
      });
    }
  }

  private currentFileText(): string {
    return (
      this.fileEditor?.getContent() ??
      this.fileDraftContent ??
      (this.visibleContent?.kind === "file" ? this.visibleContent.content : "")
    );
  }

  private readonly toggleHtmlSource = () => {
    this.fileSearchOpen = false;
    this.htmlPreview.toggle();
  };

  private scrollToFileLine(content: FileSidebarContent) {
    const line = this.fileNavigation?.line ?? content.line;
    if (this.visibleContent === content && !this.showingRawText && line != null) {
      this.fileEditor?.scrollToLine(line, true);
    }
  }

  private destroyFileEditor() {
    this.fileOperationVersion += 1;
    this.fileEditor?.destroy();
    this.fileEditor = null;
    this.fileEditorLoad = null;
  }

  private ensureFileEditor(): Promise<void> {
    if (this.fileEditor) {
      return Promise.resolve();
    }
    if (this.fileEditorLoad) {
      return this.fileEditorLoad;
    }
    const content = this.visibleContent;
    const parent = this.querySelector<HTMLElement>(".file-view__mount");
    if (content?.kind !== "file" || !parent || this.htmlPreview.showing) {
      return Promise.resolve();
    }
    const version = this.fileOperationVersion;
    this.fileEditorLoading = true;
    this.fileEditorLoad = import("./file-editor-view.ts")
      .then(async ({ createFileEditorView }) => {
        const current = this.visibleContent;
        if (version !== this.fileOperationVersion || current?.kind !== "file") {
          return;
        }
        const editor = await createFileEditorView({
          parent,
          content: this.fileDraftContent ?? current.content,
          name: current.name,
          editable: this.fileEditing,
          wrap: this.fileWrap,
          onSave: this.saveFile,
        });
        if (
          version !== this.fileOperationVersion ||
          !this.isConnected ||
          this.visibleContent?.kind !== "file"
        ) {
          editor.destroy();
          return;
        }
        // Reload may settle while the editor awaits its language support.
        editor.setContent(this.currentFileText());
        this.fileEditor = editor;
        this.fileDraftContent = null;
        editor.onDocChanged((nextContent) => {
          const draft = captureFileEditorDraft(current, {
            // Reload synchronization may normalize display text without a user edit.
            editing: this.fileEditing && !this.fileReloading,
            content: nextContent,
            dirty: !editor.contentEquals(this.fileSavedContent),
            expectedHash: this.fileHash,
          });
          if (!draft) {
            return;
          }
          this.fileDirty = draft.dirty;
          this.fileHash = draft.expectedHash;
          if (this.fileSaveNotice?.kind === "error") {
            this.fileSaveNotice = null;
          }
        });
      })
      .catch((error: unknown) => {
        if (version !== this.fileOperationVersion || !this.isConnected) {
          return;
        }
        // A failed load is terminal for this selection; renders must not retry it.
        this.error = toErrorObject(error, t("lazyView.errorTitle"));
        if (isStaleChunkImportError(this.error)) {
          void scheduleStaleChunkReload();
        }
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileEditorLoad = null;
          this.fileEditorLoading = false;
        }
      });
    return this.fileEditorLoad;
  }

  private readonly retryFileEditor = () => {
    const error = this.error;
    const version = this.fileOperationVersion;
    if (isStaleChunkImportError(error)) {
      void retryStaleChunkReloadWhenReachable({
        canReload: () =>
          this.isConnected && this.error === error && version === this.fileOperationVersion,
      });
    } else {
      this.error = null;
    }
  };

  private syncFileEditor() {
    const content = this.visibleContent;
    const editor = this.fileEditor;
    if (content?.kind !== "file" || !editor) {
      return;
    }
    if (!this.fileEditing) {
      editor.setContent(content.content);
    }
    editor.setEditable(this.fileEditing && !this.fileReloading);
    editor.setLineWrapping(this.fileWrap);
    const matches = this.fileSearchMatches();
    editor.setDecorations({
      targetLine: this.fileNavigation?.line ?? content.line,
      matches,
      currentMatch: matches[this.fileSearchMatchIndex] ?? null,
    });
  }

  private readonly handleDocumentPointerDown = (event: PointerEvent) => {
    if (!this.fileEditorMenuOpen) {
      return;
    }
    const editor = this.querySelector(".sidebar-file-view__editor");
    if (!editor || !event.composedPath().includes(editor)) {
      this.fileEditorMenuOpen = false;
    }
  };

  private fileSearchMatches(): number[] {
    const content = this.visibleContent;
    return content?.kind === "file"
      ? computeFileMatches(content.content, this.fileSearchQuery)
      : [];
  }

  private async scrollToCurrentFileMatch() {
    await this.updateComplete;
    const line = this.fileSearchMatches()[this.fileSearchMatchIndex];
    if (line != null) {
      this.fileEditor?.scrollToLine(line, true);
    }
  }

  private readonly toggleFileWrap = () => {
    this.fileWrap = !this.fileWrap;
    saveFileWrapPreference(this.fileWrap);
  };

  private readonly toggleFileSearch = () => {
    this.htmlPreview.showSource();
    this.fileSearchOpen = !this.fileSearchOpen;
    this.fileEditorMenuOpen = false;
    if (!this.fileSearchOpen) {
      this.fileSearchQuery = "";
      this.fileSearchMatchIndex = 0;
      return;
    }
    void this.updateComplete.then(() => {
      this.querySelector<HTMLInputElement>(".file-view__search input")?.focus();
    });
  };

  private readonly updateFileSearch = (query: string) => {
    this.fileSearchQuery = query;
    this.fileSearchMatchIndex = 0;
    void this.scrollToCurrentFileMatch();
  };

  private moveFileSearch(offset: number) {
    const matches = this.fileSearchMatches();
    if (matches.length === 0) {
      return;
    }
    this.fileSearchMatchIndex =
      (this.fileSearchMatchIndex + offset + matches.length) % matches.length;
    void this.scrollToCurrentFileMatch();
  }

  private readonly handleFileSearchKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.toggleFileSearch();
      this.querySelector<HTMLButtonElement>(".sidebar-file-view__search-toggle")?.focus({
        preventScroll: true,
      });
      return;
    }
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      this.moveFileSearch(event.shiftKey ? -1 : 1);
    }
  };

  private readonly openInEditor = (editor: EditorId) => {
    const content = this.visibleContent;
    if (content?.kind !== "file") {
      return;
    }
    const absPath = localEditorFilePath(content, this.execNode);
    if (!absPath) {
      return;
    }
    this.fileEditorMenuOpen = false;
    openEditor(editor, absPath, this.fileNavigation?.line ?? content.line);
  };

  private readonly editFile = async () => {
    const content = this.visibleContent;
    if (content?.kind !== "file" || !content.edit) {
      return;
    }
    this.htmlPreview.showSource();
    await this.updateComplete;
    await this.ensureFileEditor();
    if (this.visibleContent !== content || !this.fileEditor) {
      return;
    }
    if (this.fileEditing) {
      this.fileEditor.focus();
      return;
    }
    this.fileSavedContent = content.content;
    this.fileHash = content.edit.hash;
    this.fileDirty = false;
    this.fileSaveNotice = null;
    this.fileSearchOpen = false;
    this.fileSearchQuery = "";
    this.fileSearchMatchIndex = 0;
    this.fileEditorMenuOpen = false;
    this.fileEditing = true;
    this.fileEditor.setEditable(true);
    void this.updateComplete.then(() => this.fileEditor?.focus());
  };

  private readonly discardFileEdits = () => {
    if (!this.fileEditing || this.fileSaving) {
      return;
    }
    this.fileEditor?.setContent(this.fileSavedContent);
    this.fileDraftContent = null;
    this.htmlPreview.discard(this.fileSavedContent);
    const content = this.visibleContent;
    if (content?.kind === "file") {
      setFileDraft(content, null);
      this.fileHash = content.edit?.hash ?? "";
    }
    this.fileDirty = false;
    this.fileSaveNotice = null;
    this.fileEditing = false;
    this.fileEditor?.setEditable(false);
  };

  private updateSavedFile(content: FileSidebarContent, nextContent: string, hash: string) {
    const draftContent = this.currentFileText();
    this.fileSavedContent = nextContent;
    this.fileHash = hash;
    this.fileDirty = !(this.fileEditor?.contentEquals(nextContent) ?? draftContent === nextContent);
    this.fileDraftContent = !this.fileEditor && this.fileDirty ? draftContent : null;
    setFileDraft(content, this.fileDirty ? { content: draftContent, expectedHash: hash } : null);
    this.fileSaveNotice = null;
    // The retained file tab owns the saved buffer used by later reads and opens.
    content.content = nextContent;
    content.rawText = nextContent;
    if (content.edit) {
      content.edit.hash = hash;
    }
  }

  private async saveFileContent(
    content: FileSidebarContent,
    nextContent: string,
    expectedHash: string,
    version: number,
  ) {
    if (!content.edit) {
      return;
    }
    const outcome = await content.edit.save({ content: nextContent, expectedHash });
    if (version !== this.fileOperationVersion || this.visibleContent?.kind !== "file") {
      return;
    }
    if (outcome.ok) {
      this.updateSavedFile(this.visibleContent, nextContent, outcome.hash);
    } else if (outcome.code === "conflict") {
      this.fileSaveNotice = { kind: "conflict" };
    } else {
      this.fileSaveNotice = { kind: "error", message: outcome.message };
    }
  }

  private readonly saveFile = () => {
    const content = this.visibleContent;
    if (
      content?.kind !== "file" ||
      !content.edit ||
      !this.fileEditing ||
      !this.fileDirty ||
      this.fileSaving
    ) {
      return;
    }
    const version = this.fileOperationVersion;
    this.fileSaving = true;
    this.fileSaveNotice = null;
    this.trackFileOperation(
      this.saveFileContent(content, this.currentFileText(), this.fileHash, version),
      version,
    );
  };

  private readonly reloadFile = () => {
    const content = this.visibleContent;
    if (content?.kind !== "file" || !content.edit || this.fileSaving) {
      return;
    }
    const version = this.fileOperationVersion;
    this.fileSaving = true;
    this.fileReloading = true;
    this.fileEditor?.setEditable(false);
    this.trackFileOperation(
      content.edit.fetchLatest().then((latest) => {
        if (version !== this.fileOperationVersion || this.visibleContent?.kind !== "file") {
          return;
        }
        if (!latest) {
          this.fileSaveNotice = {
            kind: "error",
            message: t("chat.detailPanel.reloadFailed"),
          };
          return;
        }
        this.fileEditor?.setContent(latest.content);
        this.fileDraftContent = this.fileEditor ? null : latest.content;
        this.htmlPreview.discard(latest.content);
        this.updateSavedFile(this.visibleContent, latest.content, latest.hash);
        // A reload can bring back content that no longer qualifies for edit
        // mode (e.g. the agent rewrote the file with mixed line endings);
        // drop the edit capability instead of letting a save corrupt it.
        if (!latest.editable && this.visibleContent?.kind === "file") {
          setFileDraft(this.visibleContent, null);
          this.fileEditing = false;
          this.fileDirty = false;
          const { edit: _removed, ...readOnly } = this.visibleContent;
          this.visibleContent = readOnly;
        }
      }),
      version,
    );
  };

  private readonly overwriteFile = () => {
    const content = this.visibleContent;
    if (content?.kind !== "file" || !content.edit || this.fileSaving) {
      return;
    }
    const version = this.fileOperationVersion;
    // Overwrite deliberately replaces whatever is on disk (even content that
    // would fail the edit gates) with the local editor text the user chose.
    const localContent = this.currentFileText();
    this.fileSaving = true;
    this.trackFileOperation(
      content.edit.fetchLatest().then(async (latest) => {
        if (version !== this.fileOperationVersion) {
          return;
        }
        if (!latest) {
          this.fileSaveNotice = {
            kind: "error",
            message: t("chat.detailPanel.overwriteLoadFailed"),
          };
          return;
        }
        await this.saveFileContent(content, localContent, latest.hash, version);
      }),
      version,
    );
  };

  private trackFileOperation(operation: Promise<unknown>, version: number) {
    void operation
      .catch((error: unknown) => {
        if (version === this.fileOperationVersion) {
          this.fileSaveNotice = { kind: "error", message: formatUiError(error) };
        }
      })
      .finally(() => {
        if (version === this.fileOperationVersion) {
          this.fileSaving = false;
          if (this.fileReloading) {
            this.fileReloading = false;
            this.fileEditor?.setEditable(this.fileEditing);
          }
        }
      });
  }

  private readonly close = () => {
    this.dispatchEvent(new CustomEvent("chat-detail-panel-close", { bubbles: true }));
  };

  private readonly showRawText = () => {
    if (this.htmlPreview.file) {
      this.htmlPreview.showSource();
      return;
    }
    const rawContent = buildRawContent(this.visibleContent);
    if (!rawContent) {
      return;
    }
    this.rawFileContent = this.visibleContent?.kind === "file" ? this.visibleContent : null;
    this.showingRawText = true;
    this.destroyFileEditor();
    this.visibleContent = rawContent;
    this.error = null;
  };

  private readonly handlePanelClick = (event: MouseEvent) => {
    handleSidebarClick(event, this);
  };

  private readonly handlePanelKeyDown = (event: KeyboardEvent) => {
    if (this.scrollFileFromToolbar(event)) {
      return;
    }
    handleSidebarKeydown(event, this);
  };

  // Escape leaves focus on Search in file, outside the reader. Page keys from
  // that toolbar still have to move the file, without taking the reader's own
  // paging or a key typed into the search field.
  private scrollFileFromToolbar(event: KeyboardEvent): boolean {
    if (
      (event.key !== "PageDown" && event.key !== "PageUp") ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return false;
    }
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".cm-scroller, input, textarea, select")) {
      return false;
    }
    if (!target.closest(".sidebar-file-view")) {
      return false;
    }
    const scroller = this.querySelector<HTMLElement>(".sidebar-file-view .cm-scroller");
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
      return false;
    }
    event.preventDefault();
    scroller.scrollBy({
      top: event.key === "PageDown" ? scroller.clientHeight : -scroller.clientHeight,
    });
    return true;
  }

  override render() {
    const file = this.htmlPreview.file;
    const matches = this.fileSearchMatches();
    const currentMatchIndex = matches.length
      ? Math.min(this.fileSearchMatchIndex, matches.length - 1)
      : 0;
    return renderSidebarPanel({
      content: this.visibleContent,
      showingRawText: this.showingRawText,
      error: file ? null : this.error,
      onRetry: this.retryFileEditor,
      fileView: {
        htmlPreview: this.htmlPreview.controls({
          error: this.error,
          onRetry: this.retryFileEditor,
          onToggle: this.toggleHtmlSource,
          runtime: this.attachmentRuntime,
          mode: this.embedSandboxMode,
        }),
        copyFeedback: this.fileCopy.feedback,
        currentMatchIndex,
        dirty: this.fileDirty,
        execNode: this.execNode,
        editorMenuOpen: this.fileEditorMenuOpen,
        editing: this.fileEditing,
        loadingEditor: this.fileEditorLoading,
        mountKey: this.fileOperationVersion,
        matches,
        query: this.fileSearchQuery,
        saveNotice: this.fileSaveNotice,
        saving: this.fileSaving,
        searchOpen: this.fileSearchOpen,
        wrap: this.fileWrap,
        onCopy: this.fileCopy.copy,
        onDiscard: this.discardFileEdits,
        onEdit: () => void this.editFile(),
        onNextMatch: () => this.moveFileSearch(1),
        onOpenEditor: this.openInEditor,
        onOverwrite: this.overwriteFile,
        onPreviousMatch: () => this.moveFileSearch(-1),
        onReload: this.reloadFile,
        onReveal: this.onRevealInWorkspace ?? undefined,
        onSave: this.saveFile,
        onSearchInput: this.updateFileSearch,
        onSearchKeydown: this.handleFileSearchKeydown,
        onEditorMenuOpenChange: (open) => {
          this.fileEditorMenuOpen = open;
        },
        onToggleSearch: this.toggleFileSearch,
        onToggleWrap: this.toggleFileWrap,
      },
      canvasPluginSurfaceUrl: this.canvasPluginSurfaceUrl,
      embedSandboxMode: this.embedSandboxMode,
      allowExternalEmbedUrls: this.allowExternalEmbedUrls,
      ...this.githubContext,
      embedded: this.embedded,
      onClose: this.close,
      onOpenImage: this.onOpenImage ?? undefined,
      onViewRawText: this.showRawText,
      onClick: this.handlePanelClick,
      onKeydown: this.handlePanelKeyDown,
      onAttachmentUpdate: this.requestAttachmentUpdate,
      attachmentRuntime: this.attachmentRuntime,
      attachmentDownload: this.attachmentDownload,
    });
  }
}

if (!customElements.get("openclaw-chat-detail-panel")) {
  customElements.define("openclaw-chat-detail-panel", ChatDetailPanel);
}
