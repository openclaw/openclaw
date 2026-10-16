import { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
import { isStaleChunkImportError } from "../../../app/stale-chunk-reload.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import type { PreviewProps, SourceFallbackProps } from "./chat-html-preview-view.tsx";
import type { SidebarContent, AttachmentSidebarRuntime } from "./chat-sidebar-content-types.ts";
export type FileHtmlPreviewControls = {
  source: boolean;
  presentation: PreviewProps | null;
  sourceFallback?: SourceFallbackProps;
  onToggle: () => void;
};

registerEnglishCatalog(registerFilePreviewEnglish);

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
  loadModule: () => import("./chat-html-preview-element.tsx"),
};

/** Owns file HTML presentation while the detail panel owns its editor and draft. */
export class FileHtmlPreviewController {
  private source = false;
  private preview: string | null = null;
  private readonly loader: LazyCustomElementRequestController;

  constructor(
    private readonly host: { requestUpdate(): void; readonly updateComplete?: Promise<unknown> },
    private readonly content: () => SidebarContent | null,
    private readonly text: () => string,
  ) {
    this.loader = new LazyCustomElementRequestController(host);
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

  dispose(): void {
    this.loader.requestWhileActive(htmlPreviewElement, false);
  }

  controls(options: {
    error: Error | null;
    onRetry: () => void;
    onToggle: () => void;
    runtime: AttachmentSidebarRuntime;
    mode: EmbedSandboxMode;
  }): FileHtmlPreviewControls | undefined {
    const file = this.file;
    if (!file) {
      return undefined;
    }
    if (this.preview !== null) {
      this.loader.requestWhileActive(htmlPreviewElement, true);
    }
    return {
      source: this.source,
      onToggle: options.onToggle,
      presentation:
        this.preview === null
          ? null
          : {
              state: this.loader.visibleState,
              onRetry: () => this.loader.retry(),
              content: this.preview,
              sourceIdentity:
                file.draftKey ??
                [
                  options.runtime.sessionKey ?? "",
                  options.runtime.agentId ?? "",
                  file.root ?? "",
                  file.path,
                ].join(String.fromCharCode(0)),
              title: file.name,
              embedSandboxMode: options.mode,
              sessionFileSource: file.sessionFileSource,
            },
      sourceFallback: options.error
        ? {
            error: options.error,
            stale: isStaleChunkImportError(options.error),
            onRetry: options.onRetry,
            text: this.text(),
          }
        : undefined,
    };
  }
}
