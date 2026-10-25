import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { createMemo, createSignal, onSettled } from "solid-js";
import { TERMINAL_UPLOAD_RETENTION_MS } from "../../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import { t } from "../../i18n/index.ts";
import { registerTerminalEnglish } from "../../i18n/locales/en-terminal.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import {
  uploadsEnabled as policyAllowsUploads,
  uploadsDisabledMessage,
} from "../../lib/uploads.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  encodeTerminalUpload,
  quoteTerminalUploadPath,
  uploadTerminalFile,
} from "./terminal-file-upload.ts";

registerTerminalEnglish();

type TerminalUploadTab = {
  gatewaySessionId: string;
  shell: string;
  status: string;
  controller: GhosttyTerminalController;
};

type TerminalPanelUploadHost = {
  config?: () => ApplicationConfigCapability | undefined;
  activeTab: () => TerminalUploadTab | undefined;
  client: () => TerminalGatewayClient | null;
  isCurrent: (tab: TerminalUploadTab) => boolean;
  fileInput: () => HTMLInputElement | null;
  setError: (message: string | null) => void;
  /** An embedded composer may retain editable arguments; never submit them here. */
  stagePaths?: (
    tab: TerminalUploadTab,
    paths: readonly string[],
    files: readonly File[],
  ) => boolean;
};

type TerminalUploadBatch = {
  tab: TerminalUploadTab;
  files: File[];
  paths: string[];
  expiresAtMs: number | null;
  nextIndex: number;
  state: "uploading" | "failed";
  error: string | null;
  retryable: boolean;
  abortController: AbortController;
};

function isRetryableUploadError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    const gatewayError = error as { gatewayCode?: unknown; code?: unknown; retryable?: unknown };
    if (gatewayError.gatewayCode === "UNAVAILABLE" || gatewayError.code === "UNAVAILABLE") {
      return true;
    }
    return gatewayError.retryable === true;
  }
  return true;
}

export function createTerminalPanelUpload(host: TerminalPanelUploadHost) {
  const [dragActive, setDragActive] = createSignal(false);
  let activeBatch: TerminalUploadBatch | null = null;
  let dragDepth = 0;
  let notifyBatch = () => {};
  // Transport admission and cancellation remain synchronous; Solid reads that owner.
  const currentBatch = projectSource(() => activeBatch, {
    read: (read) => read(),
    subscribe: (_read, notify) => {
      notifyBatch = notify;
      return () => {
        notifyBatch = () => {};
      };
    },
    equality: "revision",
  });

  const uploadsEnabled = () => policyAllowsUploads(host.config?.());

  function syncPolicy(): void {
    if (!uploadsEnabled()) {
      cancel();
      setDragActive(false);
      dragDepth = 0;
    }
  }

  function admitUpload(): boolean {
    if (!host.client()) {
      return false;
    }
    if (uploadsEnabled()) {
      return true;
    }
    host.setError(uploadsDisabledMessage());
    syncPolicy();
    return false;
  }

  const hasActiveTab = () => Boolean(host.activeTab());

  const hasPendingBatch = () => currentBatch.read() !== null;

  const progress = createMemo(() => {
    const batch = currentBatch.read();
    if (!batch) {
      return null;
    }
    const total = batch.files.length;
    const currentIndex = Math.min(batch.nextIndex, total - 1);
    return {
      completed: batch.nextIndex,
      canInsert:
        batch.paths.length > 0 && (batch.expiresAtMs === null || Date.now() < batch.expiresAtMs),
      current: currentIndex + 1,
      error: batch.error,
      fileName: batch.files[currentIndex]?.name ?? "",
      retryable: batch.retryable,
      state: batch.state,
      total,
    };
  });

  function hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function admitDraggedFiles(event: DragEvent): boolean {
    if (!hasDraggedFiles(event)) {
      return false;
    }
    if (!uploadsEnabled() || !host.client()) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
      return false;
    }
    return hasActiveTab() && !hasPendingBatch();
  }

  function uploadFiles(files: File[]): void {
    if (!admitUpload()) {
      return;
    }
    const tab = host.activeTab();
    if (files.length === 0 || !tab || !host.client() || hasPendingBatch()) {
      return;
    }
    host.setError(null);
    const batch: TerminalUploadBatch = {
      tab,
      files,
      paths: [],
      expiresAtMs: null,
      nextIndex: 0,
      state: "uploading",
      error: null,
      retryable: false,
      abortController: new AbortController(),
    };
    activeBatch = batch;
    notifyBatch();
    void runBatch(batch);
  }

  function ensureCurrent(batch: TerminalUploadBatch): boolean {
    if (activeBatch !== batch) {
      return false;
    }
    if (!uploadsEnabled()) {
      host.setError(uploadsDisabledMessage());
      cancelBatch(batch);
      return false;
    }
    if (!host.isCurrent(batch.tab)) {
      cancelBatch(batch);
      return false;
    }
    return true;
  }

  function failBatch(batch: TerminalUploadBatch, error: unknown, retryable: boolean): void {
    if (!ensureCurrent(batch)) {
      return;
    }
    batch.state = "failed";
    batch.error = formatUiError(error);
    batch.retryable = retryable;
    notifyBatch();
  }

  function ensureUploadsRetained(batch: TerminalUploadBatch): boolean {
    if (batch.expiresAtMs !== null && Date.now() >= batch.expiresAtMs) {
      failBatch(batch, new Error(t("terminal.uploadExpired")), false);
      return false;
    }
    return true;
  }

  async function runBatch(batch: TerminalUploadBatch): Promise<void> {
    const client = host.client();
    const signal = batch.abortController.signal;
    if (!client || !ensureCurrent(batch)) {
      cancelBatch(batch);
      return;
    }
    while (batch.nextIndex < batch.files.length) {
      const file = batch.files[batch.nextIndex];
      if (!file || !ensureCurrent(batch) || !ensureUploadsRetained(batch)) {
        return;
      }
      let contentBase64: string;
      try {
        contentBase64 = await encodeTerminalUpload(file);
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        failBatch(batch, error, false);
        return;
      }
      if (signal.aborted || !ensureCurrent(batch)) {
        return;
      }

      let uploaded: Awaited<ReturnType<typeof uploadTerminalFile>>;
      const uploadStartedAtMs = Date.now();
      try {
        uploaded = await uploadTerminalFile(
          client,
          batch.tab.gatewaySessionId,
          { name: file.name, contentBase64 },
          signal,
        );
        if (signal.aborted || !ensureCurrent(batch)) {
          return;
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        failBatch(batch, error, isRetryableUploadError(error));
        return;
      }
      let uploadedPath: string;
      try {
        uploadedPath = quoteTerminalUploadPath(
          uploaded.path,
          batch.tab.shell,
          uploaded.uploadPathStyle,
        );
      } catch (error) {
        failBatch(batch, error, false);
        return;
      }

      batch.paths.push(uploadedPath);
      // Start conservatively before staging: a retained batch must never paste
      // its early paths after the host's cleanup deadline may have passed.
      batch.expiresAtMs ??= uploadStartedAtMs + TERMINAL_UPLOAD_RETENTION_MS;
      batch.nextIndex += 1;
      notifyBatch();
    }

    insertPaths(batch);
  }

  function insertPaths(batch: TerminalUploadBatch): void {
    if (!host.client() || !ensureCurrent(batch) || !ensureUploadsRetained(batch)) {
      return;
    }
    // Ghostty preserves bracketed-paste mode. This produces editable input,
    // never Enter, so adding a file cannot execute a shell command.
    if (!host.stagePaths?.(batch.tab, batch.paths, batch.files)) {
      batch.tab.controller.terminal.paste(batch.paths.join(" "));
      batch.tab.controller.terminal.focus();
    }
    activeBatch = null;
    notifyBatch();
  }

  const cancel = (): void => {
    if (activeBatch) {
      cancelBatch(activeBatch);
    }
  };

  function cancelForTab(tab: TerminalUploadTab): void {
    const batch = activeBatch;
    if (batch?.tab === tab) {
      cancelBatch(batch);
    }
  }

  function cancelBatch(batch: TerminalUploadBatch): void {
    if (activeBatch === batch) {
      dispose();
    }
  }

  function dispose(): void {
    activeBatch?.abortController.abort();
    activeBatch = null;
    setDragActive(false);
    dragDepth = 0;
    notifyBatch();
  }
  onSettled(() => () => {
    activeBatch?.abortController.abort();
    activeBatch = null;
  });
  return {
    dragActive,
    progress,
    uploadsEnabled,
    syncPolicy,
    hasActiveTab,
    hasPendingBatch,
    chooseFiles(this: void): void {
      if (admitUpload()) {
        host.fileInput()?.click();
      }
    },
    handleFileSelection(event: Event): void {
      const input = event.currentTarget as HTMLInputElement;
      if (!admitUpload()) {
        input.value = "";
        return;
      }
      const files = Array.from(input.files ?? []);
      input.value = "";
      uploadFiles(files);
    },
    handleDragEnter(event: DragEvent): void {
      if (!admitDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth += 1;
      setDragActive(true);
    },
    handleDragOver(event: DragEvent): void {
      if (!admitDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "copy";
      }
    },
    handleDragLeave(event: DragEvent): void {
      if (!hasDraggedFiles(event)) {
        return;
      }
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setDragActive(false);
      }
    },
    handleDrop(event: DragEvent): void {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      dragDepth = 0;
      setDragActive(false);
      if (hasPendingBatch()) {
        return;
      }
      uploadFiles(Array.from(event.dataTransfer?.files ?? []));
    },
    insertCompleted(this: void): void {
      const batch = activeBatch;
      if (batch?.state === "failed" && batch.paths.length > 0) {
        insertPaths(batch);
      }
    },
    retry(this: void): void {
      if (!admitUpload()) {
        return;
      }
      const batch = activeBatch;
      if (!batch || batch.state !== "failed" || !batch.retryable) {
        return;
      }
      if (!host.client()) {
        return;
      }
      if (!host.isCurrent(batch.tab)) {
        cancelBatch(batch);
        return;
      }
      if (!ensureUploadsRetained(batch)) {
        return;
      }
      batch.state = "uploading";
      batch.error = null;
      batch.retryable = false;
      batch.abortController = new AbortController();
      notifyBatch();
      void runBatch(batch);
    },
    cancel,
    cancelForTab,
    suspend(): void {
      const batch = activeBatch;
      if (batch?.state === "uploading") {
        batch.abortController.abort();
        batch.state = "failed";
        batch.error = t("terminal.deliveryFailed");
        batch.retryable = true;
        notifyBatch();
      }
      setDragActive(false);
      dragDepth = 0;
    },
    dispose,
  };
}

export type TerminalPanelUpload = ReturnType<typeof createTerminalPanelUpload>;
