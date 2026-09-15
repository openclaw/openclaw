import { html, nothing, type PropertyValues, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { readAttachmentText } from "./chat-attachment-text-reader.ts";
import {
  parseCommentAttachment,
  renderCommentPreviewChip,
  renderCommentPreviewRow,
  type CommentPreview,
} from "./chat-comment-preview.ts";
import type { AssistantAttachmentItem, AttachmentItem } from "./chat-message-media.ts";

export function isSentCommentAttachment(item: AssistantAttachmentItem): item is AttachmentItem {
  return (
    item.type === "attachment" &&
    item.attachment.kind === "document" &&
    item.attachment.label === "selection-comment.txt" &&
    item.attachment.mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "text/plain"
  );
}

type SentCommentSource = {
  identity: string;
  src?: string;
  sizeBytes?: number;
  pending?: boolean;
  fallback: TemplateResult | typeof nothing;
};

class ChatSentComments extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) sources: SentCommentSource[] = [];
  @property() scope = "";
  @state() private revealed = false;
  @state() private comments: Array<CommentPreview | null | undefined> = [];
  private key = "";
  private loading?: AbortController;

  override disconnectedCallback() {
    this.loading?.abort();
    this.key = "";
    super.disconnectedCallback();
  }

  protected override willUpdate(_changed: PropertyValues<this>) {
    const key = JSON.stringify([
      this.scope,
      this.sources.map(({ fallback: _fallback, ...source }) => source),
    ]);
    if (this.key !== key) {
      this.loading?.abort();
      this.loading = undefined;
      this.key = key;
      this.comments = this.sources.map((source) =>
        !source.src && !source.pending ? null : undefined,
      );
    }
    if (this.revealed && !this.loading) {
      const controller = new AbortController();
      this.loading = controller;
      this.sources.forEach((source, index) => {
        if (!source.src) {
          return;
        }
        void readAttachmentText(source.src, source.sizeBytes, controller.signal).then(
          (text) => this.accept(index, parseCommentAttachment(text), controller),
          () => this.accept(index, null, controller),
        );
      });
    }
  }

  private accept(index: number, comment: CommentPreview | null, controller: AbortController) {
    if (this.isConnected && this.loading === controller && !controller.signal.aborted) {
      this.comments = this.sources.map((_, i) => (i === index ? comment : this.comments[i]));
    }
  }

  protected override render() {
    const comments = this.sources.filter((_, index) => this.comments[index] !== null);
    return html`${
      comments.length
        ? renderCommentPreviewChip(
            comments.length,
            html`<ol class="chat-comment-preview__list">
              ${this.sources.map((source, index) => {
                const comment = this.comments[index];
                return comment
                  ? renderCommentPreviewRow(comment)
                  : comment === null
                    ? nothing
                    : html`<li class="chat-comment-preview__item muted">
                        ${source.src || source.pending ? t("common.loading") : t("chat.attachments.textPreviewUnavailable")}
                      </li>`;
              })}
            </ol>`,
            () => {
              this.revealed = true;
            },
            true,
          )
        : nothing
    }
    ${this.sources.map((source, index) => (this.comments[index] === null ? source.fallback : nothing))}`;
  }
}

customElements.define("openclaw-chat-sent-comments", ChatSentComments);
