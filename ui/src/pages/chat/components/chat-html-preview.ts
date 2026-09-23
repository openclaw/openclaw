import { html, nothing, type ReactiveController, type ReactiveControllerHost } from "lit";
import { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
import { isStaleChunkImportError } from "../../../app/stale-chunk-reload.ts";
import { renderLazyViewError } from "../../../components/lazy-view-error.ts";
import { t } from "../../../i18n/index.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import type { SidebarContent, AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";
import type { FileViewControls } from "./chat-sidebar-file-view.ts";

export { LazyCustomElementRequestController };

export function isHtmlDocument(mimeType: string, filename: string): boolean {
  return (
    mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/html" || /\.html?$/i.test(filename)
  );
}

export const htmlPreviewElement = {
  tagName: "openclaw-chat-html-preview",
  get label() {
    return t("chat.detailPanel.renderPreview");
  },
  loadModule: () => import("./chat-html-preview-element.ts"),
};

export function renderHtmlPreview(
  loader: LazyCustomElementRequestController,
  content: string,
  sourceIdentity: string,
  title: string,
  embedSandboxMode: EmbedSandboxMode,
) {
  loader.requestWhileActive(htmlPreviewElement, true);
  const state = loader.visibleState;
  // Registration is globally deduplicated, while this owner keeps the same DOM
  // through unrelated parent renders and presents an explicit load retry.
  return html`
    ${
      state?.status === "error"
        ? renderLazyViewError({
            error: state.error,
            stale: state.stale,
            onRetry: () => loader.retry(),
          })
        : state
          ? html`<div role="status">${t("common.loading")}</div>`
          : nothing
    }
    <openclaw-chat-html-preview
      .html=${content}
      .sourceIdentity=${sourceIdentity}
      .title=${title}
      .embedSandboxMode=${embedSandboxMode}
    ></openclaw-chat-html-preview>
  `;
}

/** Owns file HTML presentation while the detail panel owns its editor and draft. */
export class FileHtmlPreviewController implements ReactiveController {
  private source = false;
  private preview: string | null = null;
  private readonly loader: LazyCustomElementRequestController;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly content: () => SidebarContent | null,
    private readonly text: () => string,
  ) {
    this.loader = new LazyCustomElementRequestController(host);
    host.addController(this);
  }

  get file() {
    const file = this.content();
    return file?.kind === "file" && isHtmlDocument(file.mimeType ?? "", file.name) ? file : null;
  }

  get showing(): boolean {
    return this.file !== null && !this.source;
  }

  reset(draft: string | null, source: boolean): void {
    this.source = source;
    const file = this.file;
    this.preview = file && !source ? (draft ?? file.content) : null;
  }

  showSource(): void {
    if (!this.source) {
      this.source = true;
      this.host.requestUpdate();
    }
  }

  toggle(): void {
    if (this.source) {
      this.preview = this.text();
    }
    this.source = !this.source;
    this.host.requestUpdate();
  }

  discard(text: string): void {
    if (this.preview !== null) {
      this.preview = text;
      this.host.requestUpdate();
    }
  }

  hostDisconnected(): void {
    this.loader.requestWhileActive(htmlPreviewElement, false);
  }

  controls(options: {
    error: Error | null;
    onRetry: () => void;
    onToggle: () => void;
    runtime: AttachmentSidebarRuntime;
    mode: EmbedSandboxMode;
  }): FileViewControls["htmlPreview"] {
    const file = this.file;
    if (!file) {
      return undefined;
    }
    return {
      source: this.source,
      onToggle: options.onToggle,
      presentation:
        this.preview === null
          ? nothing
          : renderHtmlPreview(
              this.loader,
              this.preview,
              file.draftKey ??
                [
                  options.runtime.sessionKey ?? "",
                  options.runtime.agentId ?? "",
                  file.root ?? "",
                  file.path,
                ].join(String.fromCharCode(0)),
              file.name,
              options.mode,
            ),
      sourceFallback: options.error
        ? html`
            ${renderLazyViewError({ error: options.error, stale: isStaleChunkImportError(options.error), onRetry: options.onRetry })}
            <pre class="sidebar-attachment-preview__text">${this.text()}</pre>
          `
        : undefined,
    };
  }
}
