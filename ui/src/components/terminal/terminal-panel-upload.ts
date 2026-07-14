import type { GhosttyTerminalController } from "@openclaw/libterminal/browser";
import { css, html, nothing, svg } from "lit";
import { t } from "../../i18n/index.ts";
import type { TerminalGatewayClient } from "./terminal-connection.ts";
import {
  encodeTerminalUpload,
  quoteTerminalUploadPath,
  uploadTerminalFile,
} from "./terminal-file-upload.ts";

const CLOSE_GLYPH = svg`<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>`;
const DOCK_BOTTOM_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M2 10h12" /></svg>`;
const DOCK_RIGHT_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M10 2.5v11" /></svg>`;
const UPLOAD_GLYPH = svg`<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5.2 8.1 9.8 3.5a2.5 2.5 0 0 1 3.5 3.5l-6 6a3.5 3.5 0 0 1-5-5l5.8-5.8" /><path d="m4.4 9 5.2-5.2a1.4 1.4 0 0 1 2 2l-5.3 5.3a2.3 2.3 0 0 1-3.2-3.2l4.6-4.6" /></svg>`;

type TerminalUploadTab = {
  gatewaySessionId: string;
  shell: string;
  status: string;
  controller: GhosttyTerminalController;
};

type TerminalPanelUploadHost = {
  activeTab: () => TerminalUploadTab | undefined;
  client: () => TerminalGatewayClient | null;
  isCurrent: (tab: TerminalUploadTab) => boolean;
  fileInput: () => HTMLInputElement | null;
  setError: (message: string | null) => void;
  requestUpdate: () => void;
};

export class TerminalPanelUploadController {
  uploading = false;
  dragActive = false;
  private generation = 0;
  private dragDepth = 0;

  constructor(private readonly host: TerminalPanelUploadHost) {}

  hasActiveTab(): boolean {
    return Boolean(this.host.activeTab());
  }

  chooseFiles = (): void => {
    this.host.fileInput()?.click();
  };

  handleFileSelection = (event: Event): void => {
    const input = event.currentTarget as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    void this.uploadFiles(files);
  };

  private hasDraggedFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  handleDragEnter = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event) || !this.hasActiveTab() || this.uploading) {
      return;
    }
    event.preventDefault();
    this.dragDepth += 1;
    this.dragActive = true;
    this.host.requestUpdate();
  };

  handleDragOver = (event: DragEvent): void => {
    if (!this.hasDraggedFiles(event) || !this.hasActiveTab() || this.uploading) {
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
    void this.uploadFiles(Array.from(event.dataTransfer?.files ?? []));
  };

  private async uploadFiles(files: File[]): Promise<void> {
    const tab = this.host.activeTab();
    const client = this.host.client();
    if (files.length === 0 || !tab || !client || this.uploading) {
      return;
    }
    const generation = ++this.generation;
    this.uploading = true;
    this.host.setError(null);
    this.host.requestUpdate();
    const paths: string[] = [];
    try {
      for (const file of files) {
        try {
          const contentBase64 = await encodeTerminalUpload(file);
          const result = await uploadTerminalFile(client, tab.gatewaySessionId, {
            name: file.name,
            contentBase64,
          });
          paths.push(quoteTerminalUploadPath(result.path, tab.shell));
        } catch (error) {
          this.host.setError(error instanceof Error ? error.message : String(error));
          break;
        }
      }
      if (paths.length > 0 && generation === this.generation && this.host.isCurrent(tab)) {
        // Ghostty preserves bracketed-paste mode. This produces editable input,
        // never Enter, so adding a file cannot execute a shell command.
        tab.controller.terminal.paste(paths.join(" "));
        tab.controller.terminal.focus();
      }
    } finally {
      if (generation === this.generation) {
        this.uploading = false;
        this.host.requestUpdate();
      }
    }
  }

  dispose(): void {
    this.generation += 1;
    this.uploading = false;
    this.dragActive = false;
    this.dragDepth = 0;
  }
}

export function renderTerminalPanelActions(params: {
  fullscreen: boolean;
  dock: "bottom" | "right";
  upload: TerminalPanelUploadController;
  sessionPicker: unknown;
  onDock: (dock: "bottom" | "right") => void;
  onHide: () => void;
}) {
  return html`<div class="tp-actions">
    <input
      class="tp-file-input"
      type="file"
      multiple
      aria-hidden="true"
      tabindex="-1"
      @change=${params.upload.handleFileSelection}
    />
    <button
      class="tp-icon tp-upload"
      type="button"
      title=${t("terminal.addFiles")}
      aria-label=${t("terminal.addFiles")}
      ?disabled=${params.upload.uploading || !params.upload.hasActiveTab()}
      @click=${params.upload.chooseFiles}
    >
      ${UPLOAD_GLYPH}
    </button>
    ${params.fullscreen
      ? nothing
      : html`${params.sessionPicker}<button
            class="tp-icon ${params.dock === "bottom" ? "is-active" : ""}"
            type="button"
            title=${t("terminal.dockBottom")}
            aria-label=${t("terminal.dockBottom")}
            @click=${() => params.onDock("bottom")}
          >
            ${DOCK_BOTTOM_GLYPH}
          </button>
          <button
            class="tp-icon ${params.dock === "right" ? "is-active" : ""}"
            type="button"
            title=${t("terminal.dockRight")}
            aria-label=${t("terminal.dockRight")}
            @click=${() => params.onDock("right")}
          >
            ${DOCK_RIGHT_GLYPH}
          </button>
          <button
            class="tp-icon"
            type="button"
            title=${t("terminal.hide")}
            aria-label=${t("terminal.hide")}
            @click=${params.onHide}
          >
            ${CLOSE_GLYPH}
          </button>`}
  </div>`;
}

export function renderTerminalUploadLayer(upload: TerminalPanelUploadController) {
  return html`${upload.dragActive
    ? html`<div class="tp-drop-overlay">${t("terminal.dropFiles")}</div>`
    : nothing}
  ${upload.uploading
    ? html`<div class="tp-upload-status" role="status">${t("terminal.uploading")}</div>`
    : nothing}`;
}

export const terminalPanelUploadStyles = css`
  .tp-icon:disabled {
    opacity: 0.35;
    pointer-events: none;
  }
  .tp-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .tp-drop-overlay {
    position: absolute;
    z-index: 4;
    inset: 8px;
    display: grid;
    place-items: center;
    border: 1px dashed var(--accent, #ff5c5c);
    background: color-mix(in srgb, var(--bg, #0e1015) 88%, var(--accent, #ff5c5c));
    color: var(--text, #d7dae0);
    font-size: 13px;
    pointer-events: none;
  }
  .tp-upload-status {
    position: absolute;
    z-index: 3;
    right: 10px;
    bottom: 8px;
    padding: 4px 7px;
    border: 1px solid var(--border, #262b34);
    border-radius: 4px;
    background: var(--bg, #0e1015);
    color: var(--muted, #8a919e);
    font-size: 11px;
    pointer-events: none;
  }
`;
