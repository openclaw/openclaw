import { toErrorObject } from "@openclaw/normalization-core";
import { createEffect, onSettled } from "solid-js";
import { nativeGatewaysCapability } from "../../../app/native-gateways.runtime.ts";
import {
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
  scheduleStaleChunkReload,
} from "../../../app/stale-chunk-reload.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { formatUiError } from "../../../lib/format-error.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { projectOwner } from "../../../lib/reactive/projection.ts";
import { defineSolidBridge } from "../../../lib/solid-bridge.ts";
import { createSolidRenderLifecycle } from "../solid-render-lifecycle.ts";
import { createAttachmentDownload } from "./chat-attachment-download.ts";
import {
  chatDetailPanelProperties,
  createFilePresentationActions,
  createFilePresentationState,
  renderFilePanelPresentation,
} from "./chat-detail-file-presentation.ts";
import {
  createDetailOperationPresentation,
  detailPanelOperationLifetime,
  registerDetailPanelRetirement,
} from "./chat-detail-panel-operation-lifetime.ts";
import { createFileCopy } from "./chat-file-copy.ts";
import { captureFileEditorDraft, readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import { createFileSessionAttachment } from "./chat-file-session-attachment.ts";
import { createFileHtmlPreview } from "./chat-html-preview.ts";
import type {
  FileSidebarNavigation,
  AttachmentSidebarRuntime,
  FileSidebarContent,
  ChatDetailPanelContent,
  FileReaderDraftState,
  FileReaderInteraction,
  FileReaderViewRequest,
} from "./chat-sidebar-content-types.ts";
import { buildRawContent, SidebarPanel, type SidebarPanelProps } from "./chat-sidebar-content.tsx";
import type {
  ChatDetailPanel as ChatDetailPanelElement,
  ChatDetailPanelProps,
} from "./chat-sidebar-view-types.ts";
import type { FileEditorViewHandle } from "./file-editor-view.ts";

registerEnglishCatalog(registerFilePreviewEnglish);

function DetailPanel(props: ChatDetailPanelProps, host: ChatDetailPanelElement) {
  const fileAttachment = createFileSessionAttachment(props);
  const gateways = nativeGatewaysCapability();
  const nativeGateways = gateways && projectOwner(gateways, (owner) => owner);
  let disposed = false;
  let invalidateRender = () => {};
  const invalidate = () => invalidateRender();
  const afterCommit = () =>
    new Promise<void>((resolve) => {
      lifecycle.afterCommit(() => resolve(), resolve);
    });
  const isConnected = () => !disposed && host.isConnected;
  let visibleContent: ChatDetailPanelContent | null = null;
  let error: Error | null = null;
  const presentation = createFilePresentationState(props.filePresentation === "mobile");
  const fileCopy = createFileCopy(
    () => visibleContent,
    isConnected,
    () => currentFileText(),
  );
  let fileEditorLoading = false;
  let fileEditing = false;
  let fileDirty = false;
  let fileReloading = false;
  // Plain admission also protects the dirty-editor close veto.
  let fileSaving = false;
  const fileOperation = createDetailOperationPresentation();
  let fileSaveNotice: { kind: "conflict" } | { kind: "error"; message: string } | null = null;

  const htmlPreview = createFileHtmlPreview(
    () => props.content,
    () => props.fileNavigation,
    () => currentFileText(),
  );

  let fileOperationVersion = 0;
  let rawView: { file: FileSidebarContent | null } | null = null;
  let fileEditor: FileEditorViewHandle | null = null;
  let editorMount: HTMLElement | undefined;
  let fileEditorLoad: Promise<void> | null = null;
  let fileDraftContent: string | null = null;
  let fileSavedContent = "";
  let fileHash = "";
  let publishedDraft: FileReaderDraftState | null = null;
  let draftListener: ChatDetailPanelProps["onFileDraftChange"];

  const {
    syncFileEditor,
    restoreFileReadingPresentation,
    showRequestedReadingMode,
    resetFilePresentation,
    beginEditPresentation,
    ...fileActions
  } = createFilePresentationActions({
    props,
    presentation,
    htmlPreview,
    currentFileText,
    afterCommit,
    isConnected,
    invalidate,
    interact,
    fileCopy,
    content: () => visibleContent,
    editor: () => fileEditor,
    editing: () => fileEditing,
    reloading: () => fileReloading,
  });

  function interact(interaction: FileReaderInteraction) {
    if (
      visibleContent?.kind === "file" ||
      visibleContent?.kind === "image" ||
      visibleContent?.kind === "attachment"
    ) {
      props.onFileInteraction?.(visibleContent, interaction);
    }
  }

  function publishDraft() {
    const listener = props.onFileDraftChange;
    const file = visibleContent?.kind === "file" ? visibleContent : null;
    if (
      listener === draftListener &&
      (publishedDraft?.file ?? null) === file &&
      publishedDraft?.dirty === fileDirty &&
      publishedDraft?.editing === fileEditing &&
      publishedDraft?.saving === fileSaving
    ) {
      return;
    }
    draftListener = listener;
    const version = fileOperationVersion;
    const current = () =>
      isConnected() && visibleContent === file && fileOperationVersion === version;
    publishedDraft = file
      ? {
          file,
          dirty: fileDirty,
          editing: fileEditing,
          saving: fileSaving,
          save: async () => current() && (await saveFile()) && current(),
          discard: () => {
            if (!current() || fileSaving) {
              return false;
            }
            discardFileEdits();
            return !fileDirty;
          },
        }
      : null;
    listener?.(publishedDraft);
  }
  const attachmentDownload = createAttachmentDownload(
    () => (props.content === visibleContent ? props.content : null),
    () => props.attachmentRuntime,
    isConnected,
  );

  function updateSelection(
    contentChanged: boolean,
    navigationChanged: boolean,
    content: ChatDetailPanelContent | null,
    navigation: FileSidebarNavigation | null,
  ) {
    if (!contentChanged) {
      if (
        navigationChanged &&
        navigation?.line != null &&
        presentation.fileReadingMode === "preview"
      ) {
        presentation.fileReadingMode = "highlighted";
      }
      // A line link is navigation, not replacement content: keep drafts, undo,
      // save operations, and the mounted editor intact. Plain tab selection
      // does not change this request and must not reset raw view or scroll.
      if (navigationChanged && navigation && content?.kind === "file" && rawView) {
        visibleContent = rawView.file ?? content;
        rawView = null;
      }
      return;
    }
    visibleContent = content;
    error = null;
    rawView = null;
    resetFilePresentation(content, navigation);
    fileCopy.reset();
    fileOperationVersion += 1;
    fileReloading = false;
    fileSaving = false;
    fileSaveNotice = null;
    const retainedDraft =
      content?.kind === "file" && content.edit ? readFileDraft(content) : undefined;
    const restoredDraft =
      content?.kind === "file" && retainedDraft?.content !== content.content
        ? retainedDraft
        : undefined;
    if (retainedDraft && !restoredDraft && content?.kind === "file") {
      setFileDraft(content, null);
    }
    fileDraftContent = restoredDraft?.content ?? null;
    fileSavedContent = content?.kind === "file" ? content.content : "";
    fileHash =
      restoredDraft?.expectedHash ?? (content?.kind === "file" ? (content.edit?.hash ?? "") : "");
    fileEditing = Boolean(restoredDraft);
    fileDirty = Boolean(restoredDraft);
    if (restoredDraft) {
      beginEditPresentation();
    }
    fileEditorLoading =
      content?.kind === "file" &&
      !htmlPreview.showing &&
      presentation.fileReadingMode !== "preview";
    destroyFileEditor();
  }

  function updateEditor(navigate: boolean) {
    const content = visibleContent;
    if (
      content?.kind === "file" &&
      !rawView &&
      !htmlPreview.showing &&
      presentation.fileReadingMode !== "preview" &&
      !error
    ) {
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
    presentation.fileSearchOpen = false;
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
    const parent = editorMount;
    if (
      content?.kind !== "file" ||
      !parent ||
      htmlPreview.showing ||
      presentation.fileReadingMode === "preview"
    ) {
      return Promise.resolve();
    }
    const version = fileOperationVersion;
    fileEditorLoading = true;
    invalidate();
    fileEditorLoad = import("./file-editor-view.ts")
      .then(async ({ createFileEditorView }) => {
        if (version !== fileOperationVersion) {
          return;
        }
        const editor = await createFileEditorView({
          parent,
          content: fileDraftContent ?? content.content,
          name: content.name,
          language: content.language,
          isCurrent: () =>
            version === fileOperationVersion && isConnected() && parent === editorMount,
          editable: fileEditing,
          wrap: presentation.fileWrap,
          highlight: presentation.fileReadingMode === "highlighted",
          scrollFades: props.filePresentation === "mobile",
          onScrollPortRef: props.onScrollPortRef,
          onSelectContent: () => interact("selection"),
          onSave: () => void saveFile(),
        });
        if (version !== fileOperationVersion || !isConnected()) {
          editor.destroy();
          return;
        }
        // Reload may settle while the editor awaits its language support.
        editor.setContent(currentFileText());
        fileEditor = editor;
        fileDraftContent = null;
        editor.onDocChanged((nextContent) => {
          const draft = captureFileEditorDraft(content, {
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
        if (version !== fileOperationVersion || !isConnected()) {
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
        canReload: () => isConnected() && error === failedError && version === fileOperationVersion,
      });
    } else {
      error = null;
      invalidate();
    }
  };

  const editFile = async (requestCurrent: () => boolean = () => true) => {
    const content = visibleContent;
    if (content?.kind !== "file" || !content.edit || error || fileSaving || fileReloading) {
      return;
    }
    const version = fileOperationVersion;
    const current = () =>
      requestCurrent() &&
      isConnected() &&
      visibleContent === content &&
      version === fileOperationVersion &&
      Boolean(content.edit) &&
      !error &&
      !fileSaving &&
      !fileReloading;
    interact("edit");
    if (!fileEditing) {
      beginEditPresentation();
    }
    htmlPreview.showSource();
    await afterCommit();
    if (!current()) {
      return;
    }
    await ensureFileEditor();
    if (!current() || !fileEditor) {
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
    presentation.fileSearchOpen = false;
    presentation.fileSearchQuery = "";
    presentation.fileSearchMatchIndex = 0;
    presentation.fileEditorMenuOpen = false;
    fileEditing = true;
    fileEditor.setEditable(true);
    void afterCommit().then(() => {
      if (current()) {
        fileEditor?.focus();
      }
    });
  };

  function applyFileViewRequest(request: FileReaderViewRequest, current: () => boolean) {
    if (!current() || error) {
      return;
    }
    if (request.view === "edit") {
      void editFile(current);
      return;
    }
    // A view request never saves, discards, or exits an existing edit session.
    if (fileEditing) {
      return;
    }
    showRequestedReadingMode({ ...request, view: request.view });
  }

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
    restoreFileReadingPresentation();
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
    if (version !== fileOperationVersion) {
      return;
    }
    if (outcome.ok) {
      updateSavedFile(content, nextContent, outcome.hash);
    } else if (outcome.code === "conflict") {
      fileSaveNotice = { kind: "conflict" };
    } else {
      fileSaveNotice = { kind: "error", message: outcome.message };
    }
  }

  const saveFile = async (): Promise<boolean> => {
    const content = visibleContent;
    if (!fileDirty && !fileSaving) {
      return true;
    }
    if (content?.kind !== "file" || !content.edit || !fileEditing || !fileDirty || fileSaving) {
      return false;
    }
    const version = fileOperationVersion;
    fileSaving = true;
    fileSaveNotice = null;
    invalidate();
    await trackFileOperation(
      saveFileContent(content, currentFileText(), fileHash, version),
      version,
    );
    return version === fileOperationVersion && !fileDirty && !fileSaveNotice;
  };

  function startLatestFileOperation(action: "reload" | "overwrite"): void {
    const content = visibleContent;
    if (content?.kind !== "file" || !content.edit || fileSaving) {
      return;
    }
    const version = fileOperationVersion;
    const localContent = currentFileText();
    fileSaving = true;
    fileReloading = action === "reload";
    if (fileReloading) {
      fileEditor?.setEditable(false);
    }
    invalidate();
    void trackFileOperation(
      content.edit.fetchLatest().then(async (latest) => {
        if (version !== fileOperationVersion) {
          return;
        }
        if (!latest) {
          fileSaveNotice = {
            kind: "error",
            message: t(
              action === "reload"
                ? "chat.detailPanel.reloadFailed"
                : "chat.detailPanel.overwriteLoadFailed",
            ),
          };
          return;
        }
        if (action === "overwrite") {
          // Overwrite uses the local text captured at the user's click, not the fetched text.
          await saveFileContent(content, localContent, latest.hash, version);
          return;
        }
        fileEditor?.setContent(latest.content);
        fileDraftContent = fileEditor ? null : latest.content;
        htmlPreview.discard(latest.content);
        updateSavedFile(content, latest.content, latest.hash);
        // A reload can bring back content that no longer qualifies for edit
        // mode (e.g. the agent rewrote the file with mixed line endings);
        // drop the edit capability instead of letting a save corrupt it.
        if (!latest.editable) {
          setFileDraft(content, null);
          fileEditing = false;
          fileDirty = false;
          const { edit: _removed, ...readOnly } = content;
          visibleContent = readOnly;
        }
      }),
      version,
    );
  }

  function trackFileOperation(operation: Promise<unknown>, version: number) {
    const reportError = (cause: unknown) => {
      if (version === fileOperationVersion) {
        fileSaveNotice = { kind: "error", message: formatUiError(cause) };
        invalidate();
      }
    };
    const pending = operation.catch(reportError).finally(() => {
      if (version === fileOperationVersion) {
        fileSaving = false;
        if (fileReloading) {
          fileReloading = false;
          fileEditor?.setEditable(fileEditing);
        }
        invalidate();
      }
    });
    void fileOperation
      .observe(pending, () => isConnected() && version === fileOperationVersion)
      .catch(reportError);
    return pending;
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

  let previousContent: ChatDetailPanelContent | null | undefined;
  let previousNavigation: FileSidebarNavigation | null | undefined;
  let previousRuntime: AttachmentSidebarRuntime | undefined;
  const unregisterRetirement = registerDetailPanelRetirement(
    host,
    () => previousContent,
    () => previousRuntime,
    () => {
      attachmentDownload.cancel();
      fileOperation.retire();
    },
    fileAttachment.retire,
  );
  let handledFileViewRequest: FileReaderViewRequest | undefined;
  let fileViewRequestVersion = 0;
  let navigate = false;
  function renderPanel(): SidebarPanelProps {
    nativeGateways?.read();
    const content = props.content;
    const navigation = props.fileNavigation;
    const runtime = props.attachmentRuntime;
    const contentChanged = content !== previousContent;
    const navigationChanged = navigation !== previousNavigation;
    if (
      contentChanged ||
      navigation?.view !== previousNavigation?.view ||
      runtime.sessionKey !== previousRuntime?.sessionKey ||
      runtime.agentId !== previousRuntime?.agentId ||
      runtime.connectionEpoch !== previousRuntime?.connectionEpoch ||
      runtime.policyKey !== previousRuntime?.policyKey
    ) {
      fileViewRequestVersion += 1;
    }
    if (contentChanged || navigationChanged || runtime !== previousRuntime) {
      navigate ||= contentChanged || (navigationChanged && navigation?.line != null);
      updateSelection(contentChanged, navigationChanged, content, navigation);
      previousContent = content;
      previousNavigation = navigation;
      previousRuntime = runtime;
    }

    t("common.loading");
    return renderFilePanelPresentation({
      fileAttachment: fileAttachment(),
      props,
      presentation,
      htmlPreview,
      fileCopy,
      attachmentDownload,
      state: {
        visibleContent,
        error,
        rawView,
        fileSavedContent,
        fileDirty,
        fileEditing,
        fileEditorLoading,
        fileOperationVersion,
        fileSaveNotice,
        get fileSaving() {
          return fileOperation.pending() || fileSaving;
        },
      },
      setEditorMount: (element) => {
        editorMount = element;
      },
      actions: {
        ...fileActions,
        currentFileText,
        retryFileEditor,
        toggleHtmlSource,
        interact,
        discardFileEdits,
        editFile,
        overwriteFile: () => startLatestFileOperation("overwrite"),
        reloadFile: () => startLatestFileOperation("reload"),
        saveFile,
        close,
        showRawText,
        invalidate,
      },
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
      publishDraft();
      const request = props.fileNavigation?.view;
      if (request && request !== handledFileViewRequest) {
        // Consume even a mismatched request: it must not wait for a later selection.
        handledFileViewRequest = request;
        const version = fileViewRequestVersion;
        const current = () =>
          isConnected() &&
          version === fileViewRequestVersion &&
          props.content === request.file &&
          visibleContent === request.file;
        lifecycle.afterCommit(() => applyFileViewRequest(request, current));
      }
      const scrollToNavigation = navigate;
      navigate = false;
      // Mount CodeMirror after the sidebar has committed its editor host.
      queueMicrotask(() => {
        if (!disposed) {
          updateEditor(scrollToNavigation);
        }
      });
    },
  );
  onSettled(() => () => {
    unregisterRetirement();
    disposed = true;
    draftListener?.(null);
    if (fileDirty) {
      fileDraftContent = currentFileText();
    }
    destroyFileEditor();
  });
  return <SidebarPanel {...lifecycle.snapshot()} />;
}

export const ChatDetailPanel = defineSolidBridge("openclaw-chat-detail-panel", DetailPanel, {
  properties: chatDetailPanelProperties,
  ...detailPanelOperationLifetime,
});
