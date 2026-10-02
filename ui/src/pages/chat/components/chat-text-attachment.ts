import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { keyed } from "lit/directives/keyed.js";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { LazyCustomElementRequestController } from "../../../app/lazy-custom-element.ts";
import { renderCopyButton } from "../../../components/copy-button.ts";
import { icons } from "../../../components/icons.ts";
import { markdownBlocks } from "../../../components/markdown-blocks.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import { registerFilePreviewEnglish } from "../../../i18n/locales/en-file-preview.ts";
import { formatBytes } from "../../../lib/agents/display.ts";
import type { EmbedSandboxMode } from "../../../lib/chat/tool-display.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import {
  renderAttachmentPreviewSkeleton,
  renderCompactAttachmentCard,
} from "./chat-attachment-card.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import { htmlPreviewElement, isHtmlDocument, renderHtmlPreview } from "./chat-html-preview.ts";

registerFilePreviewEnglish();

export function isTextAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mimeType.startsWith("text/")) {
    return true;
  }
  if (
    /^application\/(?:(?:[\w.-]+\+)?(?:json|xml)|javascript|x-javascript|yaml|x-yaml)$/.test(
      mimeType,
    )
  ) {
    return true;
  }
  return (
    (!mimeType || mimeType === "application/octet-stream") &&
    /\.(?:txt|md|markdown|html?|log|csv|tsv|json|jsonl|xml|yaml|yml)$/i.test(filename)
  );
}

class ChatTextAttachment extends OpenClawLightDomContentsElement {
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) plainText = false;
  @property({ attribute: false }) actions: TemplateResult | typeof nothing = nothing;
  @property() embedSandboxMode: EmbedSandboxMode = "scripts";
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property({ type: Number }) sizeBytes: number | undefined;

  @state() private text: string | null = null;
  @state() private failed = false;
  @state() private source = false;

  private readonly htmlPreviewLoader = new LazyCustomElementRequestController(this);
  private loadVersion = 0;
  private abortController: AbortController | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate("src");
  }

  override disconnectedCallback(): void {
    this.cancelLoad();
    this.htmlPreviewLoader.requestWhileActive(htmlPreviewElement, false);
    super.disconnectedCallback();
  }

  private get htmlDocument(): boolean {
    return !this.plainText && isHtmlDocument(this.mimeType, this.label);
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("sourceIdentity")) {
      this.source = false;
    }
    // A retained attachment must revalidate bytes when its rendering policy changes.
    const policyChanged =
      changed.has("plainText") || changed.has("mimeType") || changed.has("label");
    if (
      policyChanged ||
      changed.has("src") ||
      changed.has("sourceIdentity") ||
      changed.has("sizeBytes")
    ) {
      this.cancelLoad();
      // Ticket refreshes must not detach a focused reader of the same attachment.
      if (
        policyChanged ||
        !this.src ||
        !this.sourceIdentity ||
        changed.has("sourceIdentity") ||
        changed.has("sizeBytes")
      ) {
        this.text = null;
      }
      this.failed = false;
      if (this.src) {
        void this.loadText();
      }
    }
  }

  private cancelLoad(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private async loadText(): Promise<void> {
    const version = this.loadVersion;
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const text = await readAttachmentText(
        this.src,
        this.sizeBytes,
        controller.signal,
        this.htmlDocument ? "html" : "full",
      );
      if (version === this.loadVersion && this.isConnected) {
        this.text = text;
      }
    } catch {
      if (version === this.loadVersion && this.isConnected) {
        this.text = null;
        this.failed = true;
      }
    } finally {
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  private retry() {
    this.cancelLoad();
    this.text = null;
    this.failed = false;
    void this.loadText();
  }

  override render() {
    const htmlDocument = this.htmlDocument;
    const mimeType = this.mimeType.split(";", 1)[0]?.trim().toLowerCase();
    const markdown =
      !this.plainText &&
      (mimeType === "text/markdown" ||
        mimeType === "text/x-markdown" ||
        /\.(?:md|markdown)$/i.test(this.label));
    const reader =
      this.text === null
        ? renderAttachmentPreviewSkeleton()
        : html`${keyed(
            this.sourceIdentity || this.loadVersion,
            html`${keyed(
              this.text,
              htmlDocument
                ? html`<div class="chat-html-preview" ?hidden=${this.source}>
                      ${renderHtmlPreview(this.htmlPreviewLoader, this.text, this.sourceIdentity || this.src, this.label, this.embedSandboxMode)}
                    </div>
                    <pre
                      class="sidebar-attachment-preview__text"
                      tabindex="0"
                      aria-label=${this.label}
                      ?hidden=${!this.source}
                    >
${this.text}</pre>`
                : markdown && !this.source
                  ? html`<article
                      class="sidebar-attachment-preview__markdown sidebar-markdown-reader sidebar-markdown"
                      dir=${detectTextDirection(this.text)}
                      aria-label=${this.label}
                      ${markdownBlocks()}
                    >
                      ${unsafeHTML(
                        toSanitizedMarkdownHtml(this.text, {
                          // The fetch already bounds document size; do not apply chat-message
                          // truncation or let an attachment load remote tracking images.
                          mode: "document",
                          remoteImages: false,
                          codeBlockInteraction: "interactive",
                        }),
                      )}
                    </article>`
                  : html`<pre
                      class="sidebar-attachment-preview__text"
                      tabindex="0"
                      aria-label=${this.label}
                    >
${this.text}</pre>`,
            )}`,
          )}`;
    return html`
      ${
        this.compact
          ? html`<div class="sidebar-file-toolbar">
              <span class="sidebar-file-toolbar__type" title=${this.mimeType}
                >${this.mimeType || this.label.split(".").at(-1)}</span
              >
              ${this.sizeBytes === undefined ? nothing : html`<span>${formatBytes(this.sizeBytes)}</span>`}
              <span class="sidebar-file-toolbar__actions">
                ${this.text !== null && !this.failed ? keyed(this.loadVersion, renderCopyButton(this.text, t("common.copy"))) : nothing}
                ${this.actions}
                ${this.failed ? html`<button class="btn btn--sm" type="button" @click=${() => this.retry()}>${t("common.retry")}</button>` : nothing}
                ${
                  (markdown || htmlDocument) && this.text !== null
                    ? html`<button
                        class="btn btn--sm"
                        type="button"
                        aria-pressed=${String(this.source)}
                        @click=${() => {
                          this.source = !this.source;
                        }}
                      >
                        ${this.source ? t("chat.workspaceFiles.preview") : htmlDocument ? t("chat.detailPanel.viewSource") : t("chat.detailPanel.viewRawText")}
                      </button>`
                    : nothing
                }
                <a
                  class="rail-header__action"
                  href=${this.src || nothing}
                  download=${this.label}
                  target="_blank"
                  rel="noreferrer"
                  aria-label=${t("chat.mediaPlayer.download", { filename: this.label })}
                  >${icons.download}</a
                >
              </span>
            </div>`
          : renderCompactAttachmentCard({
              kind: "document",
              label: this.label,
              mimeType: this.mimeType,
              sizeBytes: this.sizeBytes,
              downloadHref: this.src,
              downloadPending: !this.src,
            })
      }
      ${
        this.failed
          ? html`<p class="muted" role="status">
              ${t(htmlDocument ? "chat.attachments.htmlPreviewUnavailable" : "chat.attachments.textPreviewUnavailable")}
            </p>`
          : reader
      }
    `;
  }
}

if (!customElements.get("openclaw-chat-text-attachment")) {
  customElements.define("openclaw-chat-text-attachment", ChatTextAttachment);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-text-attachment": ChatTextAttachment;
  }
}
