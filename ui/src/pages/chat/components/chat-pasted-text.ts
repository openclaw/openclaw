import { html, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { renderCompactAttachmentFile } from "./chat-attachment-file.ts";
import { renderAttachmentChip } from "./chat-attachment-preview-chip.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";

export function isPastedTextAttachment(
  attachment: Pick<ChatAttachment, "mimeType" | "fileName" | "origin">,
): boolean {
  const { mimeType, origin, fileName } = attachment;
  // Persisted history, drafts and outbox entries can predate explicit upload origins.
  return (
    mimeType.split(";", 1)[0]?.trim().toLowerCase() === "text/plain" &&
    (origin === "paste" || (origin === undefined && /^pasted-text-\d+\.txt$/.test(fileName ?? "")))
  );
}

export function isSentPastedTextAttachment(item: AssistantAttachmentItem): item is AttachmentItem {
  return (
    item.type === "attachment" &&
    item.attachment.kind === "document" &&
    isPastedTextAttachment({
      mimeType: item.attachment.mimeType ?? "",
      fileName: item.attachment.label,
      origin: item.attachment.origin,
    })
  );
}

class ChatPastedText extends OpenClawLightDomContentsElement {
  @property() src?: string;
  @property({ attribute: false }) sizeBytes?: number;
  @property({ attribute: false }) scope = "";
  @property({ attribute: false }) onOpen?: () => void;
  @property({ attribute: false }) composerAction?: TemplateResult;
  @state() private excerpt = "";
  private key = "";
  private loading?: AbortController;

  override connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback() {
    this.loading?.abort();
    this.key = "";
    super.disconnectedCallback();
  }

  protected override willUpdate(_changed: PropertyValues<this>) {
    const key = JSON.stringify([this.scope, this.src, this.sizeBytes]);
    if (key === this.key) {
      return;
    }
    this.loading?.abort();
    this.key = key;
    this.excerpt = "";
    if (!this.src) {
      return;
    }
    const controller = new AbortController();
    this.loading = controller;
    void this.loadExcerpt(this.src, controller);
  }

  private async loadExcerpt(src: string, controller: AbortController) {
    const current = () =>
      this.isConnected && this.loading === controller && !controller.signal.aborted;
    try {
      const text = await readAttachmentText(src, this.sizeBytes, controller.signal, "excerpt");
      if (!current()) {
        return;
      }
      const { derivePastedTextExcerpt } = await import("../../../lib/chat/pasted-text-excerpt.ts");
      if (current()) {
        this.excerpt = derivePastedTextExcerpt(text);
      }
    } catch {
      // The side panel owns loading errors, retry and the original-file download.
    }
  }

  protected override render() {
    if (this.composerAction) {
      return html`<div class="chat-attachment-thumb chat-attachment-thumb--file">
        ${renderCompactAttachmentFile(
          { id: this.scope, mimeType: "text/plain" },
          {
            label: this.excerpt || t("chat.attachments.pastedText"),
            metadata: this.composerAction,
            onOpen: this.onOpen,
          },
        )}
      </div>`;
    }
    return renderAttachmentChip({
      label: this.excerpt || t("chat.attachments.pastedText"),
      icon: icons.fileText,
      onClick: this.onOpen,
    });
  }
}

customElements.define("openclaw-chat-pasted-text", ChatPastedText);
