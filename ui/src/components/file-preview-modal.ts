import { html, type PropertyValues, type TemplateResult } from "lit";
import { property, query } from "lit/decorators.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { stripFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { t } from "../i18n/index.ts";
import { registerFilePreviewEnglish } from "../i18n/locales/en-file-preview.ts";
import { OpenClawLitElement } from "../lit/openclaw-element.ts";
import { renderCopyButton } from "./copy-button.ts";
import { type FileKind, fileKindForPath } from "./file-kind.ts";
import { filePreviewModalStyles } from "./file-preview-modal.styles.ts";
import { icons } from "./icons.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";
import { renderPanelLoadingSkeleton } from "./panel-loading-skeleton.ts";
import "./modal-dialog.ts";

registerFilePreviewEnglish();

export type FilePreviewModalFile = {
  path: string;
  size: string;
  contents: string;
  message?: string;
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
  @property() layout: "files" | "document" = "files";
  @property({ attribute: false }) directories: string[] = [];
  @property({ type: Boolean }) loading = false;
  @property({ type: Boolean }) fileLoading = false;
  @property() error = "";
  @property() notice = "";
  @query(".search") private searchInput?: HTMLInputElement;
  @query(".detail-body") private detailBody?: HTMLElement;

  private filteredFiles: FilePreviewModalFile[] = [];
  private activeFile?: FilePreviewModalFile;
  private derivedInputsReady = false;
  private codeSource?: string;
  private codeChunks: string[] = [];
  private resetScrollAfterUpdate = true;
  // Reconnection does not rerun firstUpdated; defer focus until shadow DOM is ready.
  private focusAfterUpdate = false;

  static override styles = filePreviewModalStyles;

  protected override willUpdate(changed: PropertyValues<this>) {
    const inputsChanged =
      !this.derivedInputsReady ||
      changed.has("activePath") ||
      changed.has("query") ||
      changed.has("files") ||
      changed.has("layout");
    if (!inputsChanged) {
      return;
    }

    this.derivedInputsReady = true;
    this.filteredFiles = this.filterFiles();
    const nextActiveFile = this.resolveActiveFile(this.filteredFiles);
    // A late sibling read replaces the inventory, not the document being read.
    // Reset only when the displayed document or explicit view context changes.
    this.resetScrollAfterUpdate ||=
      changed.has("layout") ||
      changed.has("query") ||
      this.activeFile?.path !== nextActiveFile?.path ||
      this.activeFile?.contents !== nextActiveFile?.contents ||
      this.activeFile?.message !== nextActiveFile?.message;
    this.activeFile = nextActiveFile;

    const nextCodeSource = nextActiveFile?.contents;
    if (nextCodeSource !== this.codeSource) {
      this.codeSource = nextCodeSource;
      this.codeChunks = nextCodeSource === undefined ? [] : chunkFileContents(nextCodeSource);
    }
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
            ${
              this.layout === "document"
                ? html`<h1 class="heading">${label}</h1>
                    <button
                      class="close-button"
                      type="button"
                      aria-label=${t("common.close")}
                      @click=${this.emitClose}
                    >
                      ${icons.x}
                    </button>`
                : html`<span class="search-icon">⌕</span
                    ><input
                      class="search"
                      placeholder=${searchPlaceholder}
                      .value=${this.query}
                      @input=${this.handleQueryInput}
                    /><span class="state">${fileCount}</span>`
            }
          </header>
          ${this.notice ? html`<p class="notice" role="status">${this.notice}</p>` : ""}
          <div
            class="body ${this.layout === "document" ? "tree" : ""}"
            aria-busy=${this.loading || this.fileLoading}
          >
            <aside class="list">
              ${this.layout === "files" ? html`<div class="list-section">${listLabel} · ${filteredFiles.length}</div>` : ""}
              ${this.loading && !this.error ? renderPanelLoadingSkeleton("file-list", t("common.loading"), true) : filteredFiles.length === 0 ? (this.error ? "" : html`<div class="empty-list">${t("filePreview.noMatches")}</div>`) : this.layout === "document" ? this.renderFolder("") : filteredFiles.map((file) => this.renderItem(file))}
            </aside>
            ${
              this.error
                ? html`<section class="detail empty">
                    <p role="alert">${this.error}</p>
                    <button
                      class="button"
                      @click=${() => this.dispatchEvent(new CustomEvent("file-preview-retry", { bubbles: true, composed: true }))}
                    >
                      ${t("common.retry")}
                    </button>
                  </section>`
                : this.loading || this.fileLoading
                  ? html`<section class="detail">
                      <div class="detail-body">
                        ${renderPanelLoadingSkeleton("document", t("common.loading"), true)}
                      </div>
                    </section>`
                  : activeFile
                    ? this.renderFile(activeFile)
                    : this.renderEmpty()
            }
          </div>
          ${
            this.layout === "files"
              ? html`<footer class="foot">
                  <span class="foot-group"
                    ><span class="kbd">↑↓</span> ${t("filePreview.navigate")}</span
                  >
                  <span class="spacer"></span>
                  <button class="button" @click=${this.emitClose}>
                    ${t("common.close")} <span class="kbd">esc</span>
                  </button>
                </footer>`
              : ""
          }
        </div>
      </openclaw-modal-dialog>
    `;
  }

  private renderItem(file: FilePreviewModalFile) {
    return html`<button
      class="item ${file.path === this.activeFile?.path ? "is-active" : ""}"
      data-path=${file.path}
      aria-current=${file.path === this.activeFile?.path ? "true" : "false"}
      @pointerdown=${this.preventItemPointerFocus}
      @mousedown=${this.preventItemPointerFocus}
      @click=${() => this.emitSelect(file.path)}
    >
      <span class="item-icon">${FILE_KIND_ICONS[fileKindForPath(file.path)]}</span
      ><span class="item-name" title=${file.path}
        >${this.layout === "document" ? file.path.split("/").pop() : file.path}</span
      >${this.layout === "files" ? html`<span class="item-meta">${file.size}</span>` : ""}
    </button>`;
  }

  private renderFolder(prefix: string): TemplateResult {
    const files = this.filteredFiles.filter((file) => file.path.startsWith(prefix));
    const direct = files.filter((file) => !file.path.slice(prefix.length).includes("/"));
    const folders = new Set(
      [...files.map((file) => file.path), ...this.directories.map((directory) => `${directory}/`)]
        .filter((path) => path.startsWith(prefix) && path.slice(prefix.length).includes("/"))
        .map((path) => path.slice(prefix.length).split("/")[0]!),
    );
    return html`${direct.map((file) => this.renderItem(file))}${[...folders].toSorted().map(
      (folder) =>
        html`<details class="folder" open>
          <summary>${icons.folder}<span>${folder}</span></summary>
          <div>${this.renderFolder(`${prefix}${folder}/`)}</div>
        </details>`,
    )}`;
  }

  private handleDocumentLink = (event: MouseEvent) => {
    // SAFETY: This delegated click handler is bound to the rendered Markdown element tree.
    const anchor = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
    const href = anchor?.getAttribute("href");
    if (!href || /^[a-z][a-z0-9+.-]*:|^\/\//iu.test(href)) {
      return;
    }
    event.preventDefault();
    const base = new URL(this.activeFile?.path ?? "SKILL.md", "https://skill.invalid/");
    const target = new URL(href, base);
    let filePath: string;
    try {
      filePath = decodeURIComponent(target.pathname.slice(1));
    } catch {
      return;
    }
    const file = this.files.find((candidate) => candidate.path === filePath);
    if (file) {
      this.emitSelect(file.path);
    }
  };

  private renderFile(file: FilePreviewModalFile) {
    return html`
      <section class="detail">
        ${
          this.layout === "files"
            ? html`<div class="detail-head">
                <div class="detail-title-row">
                  <h2 class="title">${file.path}</h2>
                  ${
                    file.contents
                      ? renderCopyButton(file.contents, this.copyLabel || t("filePreview.copyFile"))
                      : ""
                  }
                </div>
                <div class="chips">
                  <span class="chip accent">${fileKind(file.path)}</span>
                  <span class="chip">${file.size}</span>
                  <span class="chip">${this.readOnlyLabel || t("filePreview.readOnly")}</span>
                  ${this.contextLabel ? html`<span class="chip ok">${this.contextLabel}</span>` : ""}
                </div>
              </div>`
            : ""
        }
        <div class="detail-body">
          ${file.message ? html`<p role="status">${file.message}</p>` : this.layout === "document" && /\.md$/iu.test(file.path) ? html`<article class="markdown" @click=${this.handleDocumentLink}>${unsafeHTML(toSanitizedMarkdownHtml(stripFrontmatterBlock(file.contents), { mode: "document", remoteImages: false, codeBlockChrome: "none", fileLinks: false }))}</article>` : html`<div class="code-content">${this.codeChunks.map((chunk, index) => html`<pre class="code-chunk" data-chunk=${index}>${chunk}</pre>`)}</div>`}
        </div>
      </section>
    `;
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
    const normalizedQuery = this.layout === "files" ? this.query.trim().toLowerCase() : "";
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
    this.resetScrollAfterUpdate = true;
    this.focusAfterUpdate = true;
    this.requestUpdate();
  }

  protected override updated(changed: PropertyValues<this>) {
    if (this.resetScrollAfterUpdate) {
      this.resetScrollAfterUpdate = false;
      const body = this.detailBody;
      if (body) {
        body.scrollTop = 0;
        body.scrollLeft = 0;
      }
    }
    if (changed.has("activePath") || changed.has("query") || changed.has("files")) {
      this.scrollActiveFileIntoView();
      if (this.layout === "document" && changed.has("activePath")) {
        this.focusModal();
      }
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
    if (this.layout === "files") {
      event.preventDefault();
    }
  };

  private handleKeydown = (event: KeyboardEvent) => {
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
      default:
    }
  };

  private focusModal() {
    const target =
      this.searchInput ??
      this.shadowRoot?.querySelector<HTMLElement>(".item.is-active, .button") ??
      this.shadowRoot?.querySelector<HTMLElement>(".close-button");
    target?.focus({ preventScroll: true });
  }

  private moveSelection(offset: number, event: KeyboardEvent) {
    event.preventDefault();
    event.stopPropagation();
    const files =
      this.layout === "document"
        ? [...(this.shadowRoot?.querySelectorAll<HTMLButtonElement>(".item") ?? [])]
            .filter((button) => !button.closest("details:not([open])"))
            .flatMap((button) =>
              this.filteredFiles.filter((file) => file.path === button.dataset.path),
            )
        : this.filterFiles();
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
    if (this.layout === "files") {
      this.focusModal();
    }
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
  skill: icons.pencilSparkles,
};

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-file-preview-modal": OpenClawFilePreviewModal;
  }
}
