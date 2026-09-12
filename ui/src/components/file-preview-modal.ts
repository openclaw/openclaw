// Control UI component implements the file preview modal element.
import { html, type PropertyValues, type TemplateResult } from "lit";
import { property, query } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { openFileActionMenu } from "../lib/file-context-menu.ts";
import {
  computeCodeWindow,
  FILE_PREVIEW_LINE_HEIGHT,
  FILE_PREVIEW_OVERSCAN,
} from "../lib/file-preview-window.ts";
import {
  availableFileActions,
  isSafeFileReference,
  type FileAction,
  type FileReference,
} from "../lib/file-reference.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { renderCopyButton } from "./copy-button.ts";
import { type FileKind, fileKindForPath } from "./file-kind.ts";
import { filePreviewModalStyles } from "./file-preview-modal.styles.ts";
import { icons } from "./icons.ts";
import "./modal-dialog.ts";

export type FilePreviewModalFile = {
  path: string;
  size: string;
  contents: string;
  reference?: FileReference;
};

export class OpenClawFilePreviewModal extends OpenClawLitElement {
  @property({ attribute: false }) files: FilePreviewModalFile[] = [];
  @property() activePath = "";
  @property() query = "";
  @property() label = "";
  @property() listLabel = "";
  @property() searchPlaceholder = "";
  @property() contextLabel = "";
  @property() readOnlyLabel = "";
  @property() emptyTitle = "";
  @property() emptySubtitle = "";
  @property() copyLabel = "";
  /** Called by the shared context menu; the owner performs the Gateway action. */
  @property({ attribute: false })
  onFileAction?: (action: FileAction, file: FilePreviewModalFile) => void | Promise<void>;
  @query(".search") private searchInput?: HTMLInputElement;
  @query(".detail-body") private detailBody?: HTMLElement;

  private filteredFiles: FilePreviewModalFile[] = [];
  private activeFile?: FilePreviewModalFile;
  private derivedInputsReady = false;
  private showFullContent = false;
  private codeSource?: string;
  private codeChunks: string[] = [];
  private codeLines: string[] = [];
  private codeStart = 0;
  private codeEnd = 0;
  private codeFrame: number | null = null;
  private codeResizeObserver: ResizeObserver | null = null;
  private codeScrollElement: HTMLElement | null = null;
  private contextMenuClose: (() => void) | null = null;
  private readonly codeLineHeight = FILE_PREVIEW_LINE_HEIGHT;
  private readonly codeOverscan = FILE_PREVIEW_OVERSCAN;
  private resetScrollAfterUpdate = true;
  // Reconnection does not rerun firstUpdated; defer focus until shadow DOM is ready.
  private focusAfterUpdate = false;

  static override styles = filePreviewModalStyles;

  protected override willUpdate(changed: PropertyValues<this>) {
    const inputsChanged =
      !this.derivedInputsReady ||
      this.resetScrollAfterUpdate ||
      changed.has("activePath") ||
      changed.has("query") ||
      changed.has("files");
    if (!inputsChanged) {
      return;
    }

    this.derivedInputsReady = true;
    this.filteredFiles = this.filterFiles();
    const nextActiveFile = this.resolveActiveFile(this.filteredFiles);
    if (nextActiveFile?.path !== this.activeFile?.path) {
      this.showFullContent = false;
    }
    this.activeFile = nextActiveFile;

    const nextCodeSource = nextActiveFile?.contents;
    if (nextCodeSource !== this.codeSource) {
      this.codeSource = nextCodeSource;
      this.codeLines = nextCodeSource === undefined ? [] : nextCodeSource.split("\n");
      this.codeChunks = nextCodeSource === undefined ? [] : chunkFileContents(nextCodeSource);
    }
    // Reset before rendering even when the selected file's contents are identical.
    this.codeStart = 0;
    this.codeEnd = this.visibleCodeEnd();

    this.resetScrollAfterUpdate = true;
  }

  override render() {
    const filteredFiles = this.filteredFiles;
    const activeFile = this.activeFile;
    const fileCount =
      filteredFiles.length === this.files.length
        ? t("filePreview.fileCount", { count: String(this.files.length) })
        : t("filePreview.filteredFileCount", {
            count: String(filteredFiles.length),
            total: String(this.files.length),
          });
    const label = this.label || t("filePreview.label");
    const listLabel = this.listLabel || t("filePreview.listLabel");
    const searchPlaceholder = this.searchPlaceholder || t("filePreview.searchPlaceholder");

    return html`
      <openclaw-modal-dialog
        label=${label}
        style="--openclaw-modal-width: min(1100px, 92vw); --openclaw-modal-max-height: 86vh;"
        @modal-cancel=${this.emitClose}
        @keydown=${this.handleKeydown}
      >
        <div class="modal">
          <header class="head">
            <span class="search-icon">⌕</span>
            <input
              class="search"
              placeholder=${searchPlaceholder}
              .value=${this.query}
              @input=${this.handleQueryInput}
            />
            <span class="state">${fileCount}</span>
          </header>
          <div class="body">
            <aside class="list">
              <div class="list-section">${listLabel} · ${filteredFiles.length}</div>
              ${
                filteredFiles.length === 0
                  ? html`<div class="empty-list">${t("filePreview.noMatches")}</div>`
                  : filteredFiles.map(
                      (file) => html`
                        <button
                          class="item ${file.path === activeFile?.path ? "is-active" : ""}"
                          @pointerdown=${this.preventItemPointerFocus}
                          @mousedown=${this.preventItemPointerFocus}
                          @click=${() => this.emitSelect(file.path)}
                          @contextmenu=${(event: MouseEvent) => this.handleFileContextMenu(event, file)}
                          @keydown=${(event: KeyboardEvent) => this.handleFileItemKeydown(event, file)}
                        >
                          <span class="item-icon">${iconForFile(file.path)}</span>
                          <span class="item-name">${file.path}</span>
                          <span class="item-meta">${file.size}</span>
                        </button>
                      `,
                    )
              }
            </aside>
            ${activeFile ? this.renderFile(activeFile) : this.renderEmpty()}
          </div>
          <footer class="foot">
            <span class="foot-group"><span class="kbd">↑↓</span> ${t("filePreview.navigate")}</span>
            <span class="spacer"></span>
            <button class="button" @click=${this.emitClose}>
              ${t("common.close")} <span class="kbd">esc</span>
            </button>
          </footer>
        </div>
      </openclaw-modal-dialog>
    `;
  }

  private renderFile(file: FilePreviewModalFile) {
    return html`
      <section class="detail">
        <div class="detail-head">
          <div class="detail-title-row">
            <h2 class="title" id="file-preview-active-title">${file.path}</h2>
            ${
              this.codeLines.length >= 2000
                ? html`
                    <button
                      class="button"
                      type="button"
                      aria-pressed=${String(this.showFullContent)}
                      aria-describedby="file-preview-full-content-hint"
                      @click=${this.toggleFullContent}
                    >
                      ${t("filePreview.showFullContent")}
                    </button>
                  `
                : ""
            }
            ${
              file.contents
                ? renderCopyButton(file.contents, this.copyLabel || t("filePreview.copyFile"))
                : ""
            }
          </div>
          ${
            this.codeLines.length >= 2000
              ? html`
                  <p class="full-content-hint" id="file-preview-full-content-hint">
                    ${t(this.showFullContent ? "filePreview.fullContentActive" : "filePreview.fullContentHint")}
                  </p>
                `
              : ""
          }
          <div class="chips">
            <span class="chip accent">${fileKind(file.path)}</span>
            <span class="chip">${file.size}</span>
            <span class="chip">${this.readOnlyLabel || t("filePreview.readOnly")}</span>
            ${this.contextLabel ? html`<span class="chip ok">${this.contextLabel}</span>` : ""}
          </div>
        </div>
        <div
          class="detail-body"
          tabindex="0"
          role="region"
          aria-labelledby="file-preview-active-title"
          @contextmenu=${(event: MouseEvent) => this.handleFileContextMenu(event, file)}
        >
          <div class="code-content">${this.renderCode(file)}</div>
        </div>
      </section>
    `;
  }

  private renderCode(file: FilePreviewModalFile) {
    if (this.showFullContent) {
      return html`<pre class="code-full" .textContent=${file.contents}></pre>`;
    }
    if (file.contents && this.shouldVirtualizeCode()) {
      const top = this.codeStart * this.codeLineHeight;
      const bottom = Math.max(0, this.codeLines.length - this.codeEnd) * this.codeLineHeight;
      return html`
        <div class="code-vscroll">
          <div class="code-spacer" style=${`height:${top}px`}></div>
          ${this.codeLines
            .slice(this.codeStart, this.codeEnd)
            .map(
              (line, index) =>
                html`<div
                  class="code-line"
                  data-line=${this.codeStart + index + 1}
                  .textContent=${line || " "}
                ></div>`,
            )}
          <div class="code-spacer" style=${`height:${bottom}px`}></div>
        </div>
      `;
    }
    return this.codeChunks.map(
      (chunk, index) => html`<pre class="code-chunk" data-chunk=${index}>${chunk}</pre>`,
    );
  }

  private renderEmpty() {
    return html`
      <section class="detail empty">
        <p class="empty-title">${this.emptyTitle || t("filePreview.emptyTitle")}</p>
        <p class="empty-subtitle">${this.emptySubtitle || t("filePreview.emptySubtitle")}</p>
      </section>
    `;
  }

  private filterFiles(): FilePreviewModalFile[] {
    const normalizedQuery = this.query.trim().toLowerCase();
    if (!normalizedQuery) {
      return this.files;
    }
    return this.files.filter((file) => {
      const haystack = `${file.path}\n${file.contents}`.toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }

  private resolveActiveFile(files: FilePreviewModalFile[]): FilePreviewModalFile | undefined {
    return files.find((file) => file.path === this.activePath) ?? files[0];
  }

  override connectedCallback() {
    super.connectedCallback();
    this.showFullContent = false;
    this.resetScrollAfterUpdate = true;
    this.focusAfterUpdate = true;
    this.requestUpdate();
  }

  override disconnectedCallback() {
    this.closeContextMenu();
    this.detachCodeViewport();
    super.disconnectedCallback();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (this.resetScrollAfterUpdate) {
      this.resetScrollAfterUpdate = false;
      const body = this.detailBody;
      if (body) {
        body.scrollTop = 0;
        body.scrollLeft = 0;
      }
      this.resetCodeScroll();
    }
    this.attachCodeViewport();
    if (changed.has("activePath") || changed.has("query") || changed.has("files")) {
      this.scrollActiveFileIntoView();
    }
    if (this.focusAfterUpdate && this.isConnected) {
      this.focusAfterUpdate = false;
      this.focusModal();
    }
  }

  private handleQueryInput = (event: Event) => {
    const nextQuery = (event.target as HTMLInputElement).value ?? "";
    this.dispatchEvent(
      new CustomEvent<string>("file-preview-query-change", {
        bubbles: true,
        composed: true,
        detail: nextQuery,
      }),
    );
  };

  private preventItemPointerFocus = (event: Event) => {
    event.preventDefault();
  };

  private toggleFullContent = () => {
    this.showFullContent = !this.showFullContent;
    this.detachCodeViewport();
    this.resetScrollAfterUpdate = true;
    this.requestUpdate();
  };

  private shouldVirtualizeCode(): boolean {
    return !this.showFullContent && this.codeLines.length >= 2000;
  }

  private detachCodeViewport() {
    this.codeResizeObserver?.disconnect();
    this.codeResizeObserver = null;
    if (this.codeScrollElement) {
      this.codeScrollElement.removeEventListener("scroll", this.handleCodeScroll);
      this.codeScrollElement = null;
    }
    if (this.codeFrame !== null) {
      cancelAnimationFrame(this.codeFrame);
      this.codeFrame = null;
    }
  }

  private visibleCodeEnd(): number {
    const viewport = this.detailBody?.clientHeight || 620;
    return computeCodeWindow(
      this.codeLines.length,
      0,
      viewport,
      this.codeLineHeight,
      this.codeOverscan,
    ).end;
  }

  private resetCodeScroll() {
    this.codeStart = 0;
    this.codeEnd = this.visibleCodeEnd();
    if (this.detailBody) {
      this.detailBody.scrollTop = 0;
      this.detailBody.scrollLeft = 0;
    }
    this.scheduleCodeRange();
  }

  private attachCodeViewport() {
    const body = this.detailBody;
    if (!body || !this.shouldVirtualizeCode()) {
      this.detachCodeViewport();
      return;
    }
    if (body === this.codeScrollElement) {
      return;
    }
    this.codeScrollElement?.removeEventListener("scroll", this.handleCodeScroll);
    this.codeScrollElement = body;
    body.addEventListener("scroll", this.handleCodeScroll, { passive: true });
    this.codeResizeObserver?.disconnect();
    if (typeof ResizeObserver === "function") {
      this.codeResizeObserver = new ResizeObserver(() => this.scheduleCodeRange());
      this.codeResizeObserver.observe(body);
    }
    this.scheduleCodeRange();
  }

  private handleCodeScroll = () => {
    this.scheduleCodeRange();
  };

  private scheduleCodeRange() {
    if (this.codeFrame !== null || !this.shouldVirtualizeCode()) {
      return;
    }
    this.codeFrame = requestAnimationFrame(() => {
      this.codeFrame = null;
      if (!this.isConnected || !this.shouldVirtualizeCode()) {
        return;
      }
      const body = this.codeScrollElement ?? this.detailBody;
      if (!body) {
        return;
      }
      const { start, end } = computeCodeWindow(
        this.codeLines.length,
        body.scrollTop,
        body.clientHeight,
        this.codeLineHeight,
        this.codeOverscan,
      );
      if (start !== this.codeStart || end !== this.codeEnd) {
        this.codeStart = start;
        this.codeEnd = end;
        this.requestUpdate();
      }
    });
  }

  private handleFileItemKeydown(event: KeyboardEvent, file: FilePreviewModalFile) {
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      this.handleFileContextMenu(event, file);
    }
  }

  private handleFileContextMenu(event: Event, file: FilePreviewModalFile) {
    this.closeContextMenu();
    const actions: readonly FileAction[] =
      this.onFileAction && file.reference
        ? isSafeFileReference(file.reference)
          ? availableFileActions(file.reference, { hasContents: Boolean(file.contents) })
          : []
        : this.onFileAction
          ? ["copyFilename", "copyContents", "download", "refresh"]
          : ["copyFilename", "copyContents"];
    const container = this.shadowRoot?.querySelector<HTMLElement>(".modal");
    if (!container) {
      return;
    }
    this.contextMenuClose = openFileActionMenu({
      event,
      actions,
      container,
      onAction: async (action) => {
        if (this.onFileAction) {
          await this.onFileAction(action, file);
        } else if (action === "copyFilename") {
          await navigator.clipboard.writeText(file.path.split(/[\\/]/).pop() ?? file.path);
        } else if (action === "copyContents") {
          await navigator.clipboard.writeText(file.contents);
        }
      },
    });
  }

  private closeContextMenu() {
    this.contextMenuClose?.();
    this.contextMenuClose = null;
  }
  private handleKeydown = (event: KeyboardEvent) => {
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      this.detailBody &&
      event.composedPath().includes(this.detailBody)
    ) {
      return;
    }
    switch (event.key) {
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        this.emitClose();
        return;
      case "ArrowDown":
        this.moveSelection(1, event);
        return;
      case "ArrowUp":
        this.moveSelection(-1, event);
        break;
      default:
    }
  };

  private focusModal() {
    const target = this.searchInput ?? this.shadowRoot?.querySelector<HTMLElement>(".modal");
    target?.focus({ preventScroll: true });
  }

  private moveSelection(offset: number, event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    const files = this.filteredFiles;
    if (files.length === 0) {
      return;
    }
    const activeFile = this.resolveActiveFile(files);
    const currentIndex = activeFile ? files.findIndex((file) => file.path === activeFile.path) : -1;
    const nextIndex = Math.max(0, Math.min(files.length - 1, currentIndex + offset));
    const nextFile = files[nextIndex];
    if (nextFile && nextFile.path !== activeFile?.path) {
      this.emitSelect(nextFile.path);
    }
  }

  private scrollActiveFileIntoView() {
    this.updateComplete
      .then(() => {
        if (!this.isConnected) {
          return;
        }
        this.shadowRoot
          ?.querySelector<HTMLElement>(".item.is-active")
          ?.scrollIntoView({ block: "nearest" });
      })
      .catch(() => {});
  }

  private emitSelect(path: string) {
    this.dispatchEvent(
      new CustomEvent<string>("file-preview-select", {
        bubbles: true,
        composed: true,
        detail: path,
      }),
    );
    this.focusModal();
  }

  private emitClose = () => {
    this.dispatchEvent(
      new CustomEvent("file-preview-close", {
        bubbles: true,
        composed: true,
      }),
    );
  };
}

const FILE_PREVIEW_CHUNK_LINES = 64;

function chunkFileContents(contents: string): string[] {
  const lines = contents.split("\n");
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += FILE_PREVIEW_CHUNK_LINES) {
    chunks.push(lines.slice(index, index + FILE_PREVIEW_CHUNK_LINES).join("\n"));
  }
  return chunks;
}

function fileKind(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "Markdown",
    txt: t("filePreview.kind.text"),
    json: "JSON",
    yaml: "YAML",
    yml: "YAML",
    ts: "TypeScript",
    js: "JavaScript",
    py: "Python",
    sh: t("filePreview.kind.shell"),
  };
  return map[ext] ?? (ext ? ext.toUpperCase() : t("filePreview.kind.file"));
}

// Same glyph vocabulary chat file links paint through CSS masks
// (styles/chat/text.css), resolved from the shared kind so a file looks the
// same wherever the Control UI names it.
const FILE_KIND_ICONS: Record<FileKind, TemplateResult> = {
  code: icons.fileCode,
  component: icons.layoutGrid,
  data: icons.braces,
  file: icons.fileText,
  image: icons.image,
  markdown: icons.book,
  package: icons.box,
  shell: icons.terminal,
};

function iconForFile(path: string) {
  return FILE_KIND_ICONS[fileKindForPath(path)];
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-file-preview-modal": OpenClawFilePreviewModal;
  }
}
