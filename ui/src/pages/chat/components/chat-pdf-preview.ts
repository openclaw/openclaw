import { html, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import {
  renderAttachmentPreviewSkeleton,
  renderCompactAttachmentCard,
} from "./chat-attachment-card.ts";
import { safeAttachmentHref } from "./chat-attachment-href.ts";
import { readResponseBytesWithinLimit } from "./chat-response-bytes.ts";

const PDF_PREVIEW_MAX_BYTES = 16 * 1024 * 1024;
const PDF_PREVIEW_TIMEOUT_MS = 10_000;

export function isPdfAttachment(rawMimeType: string, filename: string): boolean {
  const mimeType = rawMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mimeType === "application/pdf" ||
    ((!mimeType || mimeType === "application/octet-stream") && /\.pdf$/i.test(filename))
  );
}

/** Owns the bounded, browser-native PDF surface for same-origin attachments. */
class ChatPdfPreview extends OpenClawLightDomContentsElement {
  @property() src = "";
  @property() sourceIdentity = "";
  @property() label = "";
  @property() mimeType = "";
  @property({ type: Number }) sizeBytes: number | undefined;
  @property() downloadHref = "";

  @state() private status: "loading" | "ready" | "error" = "loading";
  @state() private previewUrl: string | null = null;

  private loadVersion = 0;
  private abortController: AbortController | undefined;
  private previewObjectUrl: string | undefined;
  private previewBytes: Uint8Array | undefined;

  override connectedCallback(): void {
    super.connectedCallback();
    this.requestUpdate("src");
  }

  override disconnectedCallback(): void {
    this.cancelLoad();
    this.revokePreviewUrl();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues<this>): void {
    if (changed.has("src") || changed.has("sourceIdentity") || changed.has("sizeBytes")) {
      this.cancelLoad();
      // A renewed ticket for the same attachment must not reset the native reader.
      if (
        !this.src ||
        !this.previewUrl ||
        !this.sourceIdentity ||
        changed.has("sourceIdentity") ||
        changed.has("sizeBytes")
      ) {
        this.revokePreviewUrl();
        this.status = "loading";
      }
      if (this.src) {
        void this.loadPdf();
      }
    }
  }

  private cancelLoad(): void {
    this.loadVersion += 1;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  private revokePreviewUrl(): void {
    if (this.previewObjectUrl) {
      URL.revokeObjectURL(this.previewObjectUrl);
      this.previewObjectUrl = undefined;
    }
    this.previewUrl = null;
    this.previewBytes = undefined;
  }

  private async loadPdf(): Promise<void> {
    if (this.sizeBytes !== undefined && this.sizeBytes > PDF_PREVIEW_MAX_BYTES) {
      this.status = "error";
      return;
    }

    const version = this.loadVersion;
    const controller = new AbortController();
    this.abortController = controller;
    const timeout = setTimeout(() => controller.abort(), PDF_PREVIEW_TIMEOUT_MS);
    try {
      const response = await fetch(this.src, {
        credentials: "same-origin",
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("PDF attachment unavailable");
      }
      const bytes = await readResponseBytesWithinLimit(response, PDF_PREVIEW_MAX_BYTES);
      if (!bytes) {
        throw new Error("PDF attachment exceeds preview limit");
      }
      if (version !== this.loadVersion || !this.isConnected) {
        return;
      }
      const nextBytes = new Uint8Array(bytes);
      if (
        this.previewBytes?.length === nextBytes.length &&
        this.previewBytes.every((byte, index) => byte === nextBytes[index])
      ) {
        return;
      }
      this.revokePreviewUrl();
      const objectUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      this.previewBytes = nextBytes;
      this.previewObjectUrl = objectUrl;
      this.previewUrl = objectUrl;
      this.status = "ready";
    } catch {
      if (version === this.loadVersion && this.isConnected) {
        this.revokePreviewUrl();
        this.status = "error";
      }
    } finally {
      clearTimeout(timeout);
      if (this.abortController === controller) {
        this.abortController = undefined;
      }
    }
  }

  override render() {
    const downloadHref = safeAttachmentHref(this.downloadHref || this.src);
    return html`
      <div class="sidebar-pdf-preview" aria-label=${this.label}>
        <div class="sidebar-pdf-preview__surface">
          ${
            this.status === "loading"
              ? renderAttachmentPreviewSkeleton()
              : this.status === "error" || !this.previewUrl
                ? html`<div class="sidebar-attachment-preview__unavailable" role="alert">
                    ${t("chat.attachments.previewUnavailable")}
                    ${renderCompactAttachmentCard({
                      kind: "document",
                      label: this.label,
                      mimeType: this.mimeType,
                      sizeBytes: this.sizeBytes,
                      downloadHref: downloadHref ?? undefined,
                    })}
                  </div>`
                : html`<iframe
                    class="sidebar-pdf-preview__frame"
                    title=${this.label}
                    src=${this.previewUrl}
                    referrerpolicy="no-referrer"
                  ></iframe>`
          }
        </div>
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-pdf-preview")) {
  customElements.define("openclaw-chat-pdf-preview", ChatPdfPreview);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-pdf-preview": ChatPdfPreview;
  }
}
