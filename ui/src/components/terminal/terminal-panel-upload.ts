import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { TERMINAL_UPLOAD_RETENTION_MS } from "../../../../packages/gateway-protocol/src/schema/terminal-constants.js";
import type { ApplicationConfigCapability } from "../../app/config.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../lib/uploads.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  encodeTerminalUpload,
  quoteTerminalUploadPath,
  uploadTerminalFile,
} from "./terminal-file-upload.ts";

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
  requestUpdate: () => void;
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

export class TerminalPanelUploadController {
  dragActive = false;
  private batch: TerminalUploadBatch | null = null;
  private dragDepth = 0;

  constructor(private readonly host: TerminalPanelUploadHost) {}

  uploadsEnabled(): boolean {
    return uploadsEnabled(this.host.config?.());
  }

  syncPolicy(): void {
    if (!this.uploadsEnabled()) {
      this.cancel();
      this.dragActive = false;
      this.dragDepth = 0;
    }
  }

  private admitUpload(): boolean {
    if (this.uploadsEnabled()) {
      return true;
    }
    this.host.setError(uploadsDisabledMessage());
    this.syncPolicy();
    return false;
  }

  hasActiveTab(): boolean {
    return Boolean(this.host.activeTab());
  }

  hasPendingBatch(): boolean {
    return this.batch !== null;
  }

  get progress() {
    const batch = this.batch;
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
  }

  chooseFiles = (): void => {
    if (this.admitUpload()) {
      this.host.fileInput()?.click();
    }
  };

  handleFileSelection = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    if (!this.admitUpload()) {
      input.value = "";
      return;
    }
    const files = Array.from(input.files ?? []);
    input.value = "";
    this.uploadFiles(files);
  };

  private hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  private admitDraggedFiles(event: DragEvent): boolean {
    if (!this.hasDraggedFiles(event)) {
      return false;
    }
    if (!this.uploadsEnabled()) {
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = "none";
      }
      return false;
    }
    return this.hasActiveTab() && !this.hasPendingBatch();
  }

  handleDragEnter = (event: DragEvent): void => {
    if (!this.admitDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth += 1;
    this.dragActive = true;
    this.host.requestUpdate();
  };

  handleDragOver = (event: DragEvent): void => {
    if (!this.admitDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  handleDragLeave = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event)) {
      return;
    }
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.dragActive = false;
      this.host.requestUpdate();
    }
  };

  handleDrop = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event)) {
      return;
    }
    event.preventDefault();
    this.dragDepth = 0;
    this.dragActive = false;
    this.host.requestUpdate();
    if (this.hasPendingBatch()) {
      return;
    }
    this.uploadFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  private uploadFiles(files: File[]): void {
    if (!this.admitUpload()) {
      return;
    }
    const tab = this.host.activeTab();
    if (files.length === 0 || !tab || !this.host.client() || this.hasPendingBatch()) {
      return;
    }
    this.host.setError(null);
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
    this.batch = batch;
    this.host.requestUpdate();
    void this.runBatch(batch);
  }

  private isActive(batch: TerminalUploadBatch): boolean {
    return this.batch === batch && !batch.abortController.signal.aborted;
  }

  private ensureCurrent(batch: TerminalUploadBatch): boolean {
    if (!this.isActive(batch)) {
      return false;
    }
    if (!this.uploadsEnabled()) {
      this.host.setError(uploadsDisabledMessage());
      this.cancelBatch(batch);
      return false;
    }
    if (!this.host.isCurrent(batch.tab)) {
      this.cancelBatch(batch);
      return false;
    }
    return true;
  }

  private failBatch(batch: TerminalUploadBatch, error: unknown, retryable: boolean): void {
    if (!this.ensureCurrent(batch)) {
      return;
    }
    batch.state = "failed";
    batch.error = formatUiError(error);
    batch.retryable = retryable;
    this.host.requestUpdate();
  }

  private ensureUploadsRetained(batch: TerminalUploadBatch): boolean {
    if (batch.expiresAtMs !== null && Date.now() >= batch.expiresAtMs) {
      this.failBatch(batch, new Error(t("terminal.uploadExpired")), false);
      return false;
    }
    return true;
  }

  private async runBatch(batch: TerminalUploadBatch): Promise<void> {
    const client = this.host.client();
    if (!client || !this.ensureCurrent(batch)) {
      this.cancelBatch(batch);
      return;
    }
    while (batch.nextIndex < batch.files.length) {
      const file = batch.files[batch.nextIndex];
      if (!file || !this.ensureCurrent(batch) || !this.ensureUploadsRetained(batch)) {
        return;
      }
      this.host.requestUpdate();

      let contentBase64: string;
      try {
        contentBase64 = await encodeTerminalUpload(file);
      } catch (error) {
        this.failBatch(batch, error, false);
        return;
      }
      if (!this.ensureCurrent(batch)) {
        return;
      }

      let uploaded: Awaited<ReturnType<typeof uploadTerminalFile>>;
      const uploadStartedAtMs = Date.now();
      try {
        uploaded = await uploadTerminalFile(
          client,
          batch.tab.gatewaySessionId,
          { name: file.name, contentBase64 },
          batch.abortController.signal,
        );
        if (!this.ensureCurrent(batch)) {
          return;
        }
      } catch (error) {
        this.failBatch(batch, error, isRetryableUploadError(error));
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
        this.failBatch(batch, error, false);
        return;
      }

      batch.paths.push(uploadedPath);
      // Start conservatively before staging: a retained batch must never paste
      // its early paths after the host's cleanup deadline may have passed.
      batch.expiresAtMs ??= uploadStartedAtMs + TERMINAL_UPLOAD_RETENTION_MS;
      batch.nextIndex += 1;
      this.host.requestUpdate();
    }

    this.insertPaths(batch);
  }

  private insertPaths(batch: TerminalUploadBatch): void {
    if (!this.ensureCurrent(batch) || !this.ensureUploadsRetained(batch)) {
      return;
    }
    // Ghostty preserves bracketed-paste mode. This produces editable input,
    // never Enter, so adding a file cannot execute a shell command.
    batch.tab.controller.terminal.paste(batch.paths.join(" "));
    batch.tab.controller.terminal.focus();
    this.batch = null;
    this.host.requestUpdate();
  }

  insertCompleted = (): void => {
    const batch = this.batch;
    if (batch?.state === "failed" && batch.paths.length > 0) {
      this.insertPaths(batch);
    }
  };

  retry = (): void => {
    if (!this.admitUpload()) {
      return;
    }
    const batch = this.batch;
    if (!batch || batch.state !== "failed" || !batch.retryable) {
      return;
    }
    if (!this.host.isCurrent(batch.tab) || !this.host.client()) {
      this.cancelBatch(batch);
      return;
    }
    if (!this.ensureUploadsRetained(batch)) {
      return;
    }
    batch.state = "uploading";
    batch.error = null;
    batch.retryable = false;
    batch.abortController = new AbortController();
    this.host.requestUpdate();
    void this.runBatch(batch);
  };

  cancel = (): void => {
    const batch = this.batch;
    if (batch) {
      this.cancelBatch(batch);
    }
  };

  cancelForTab(tab: TerminalUploadTab): void {
    const batch = this.batch;
    if (batch?.tab === tab) {
      this.cancelBatch(batch);
    }
  }

  private cancelBatch(batch: TerminalUploadBatch): void {
    if (this.batch !== batch) {
      return;
    }
    this.dispose();
    this.host.requestUpdate();
  }

  dispose(): void {
    this.batch?.abortController.abort();
    this.batch = null;
    this.dragActive = false;
    this.dragDepth = 0;
  }
}
