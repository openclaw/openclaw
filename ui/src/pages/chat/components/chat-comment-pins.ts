import { html } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatMessageMetadataEnglish } from "../../../i18n/locales/en-chat-message-metadata.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { chatCommentLineEnd, resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { currentChatComments } from "./chat-comment-controller.ts";
import "../../../styles/chat/selection-annotations.css";

registerChatMessageMetadataEnglish();

/** Draft attachments own the data; this transcript-local view owns source pins. */
class ChatCommentPins extends OpenClawLightDomElement {
  @property({ attribute: false }) props!: ChatAttachmentControlsProps;
  @property() sessionKey = "";
  private root: HTMLElement | null = null;
  private resizeObserver?: ResizeObserver;
  private mutationObserver?: MutationObserver;
  private frame?: number;
  private observedInner?: Element;

  protected override updated() {
    if (!this.root) {
      this.root = this.closest(".chat-thread");
      if (this.root) {
        this.resizeObserver = new ResizeObserver(this.scheduleLayout);
        this.resizeObserver.observe(this.root);
        this.mutationObserver = new MutationObserver((records) => {
          if (records.some((record) => !this.contains(record.target))) {
            this.scheduleLayout();
          }
        });
        this.mutationObserver.observe(this.root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
        });
        this.root.addEventListener("scroll", this.scheduleLayout, { passive: true });
      }
    }
    this.scheduleLayout();
  }

  override disconnectedCallback() {
    this.resizeObserver?.disconnect();
    this.mutationObserver?.disconnect();
    this.root?.removeEventListener("scroll", this.scheduleLayout);
    this.root = null;
    this.observedInner = undefined;
    if (this.frame !== undefined) {
      cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
    super.disconnectedCallback();
  }

  private readonly scheduleLayout = () => {
    if (this.frame !== undefined || !this.isConnected) {
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = undefined;
      this.layoutPins();
    });
  };

  private layoutPins() {
    if (!this.root) {
      return;
    }
    const inner = this.root.querySelector(".chat-thread-inner");
    if (inner && inner !== this.observedInner) {
      if (this.observedInner) {
        this.resizeObserver?.unobserve(this.observedInner);
      }
      this.resizeObserver?.observe(inner);
      this.observedInner = inner;
    }
    const origin = this.getBoundingClientRect();
    const edge = this.root.getBoundingClientRect().right - 28;
    const occupied: Array<{ left: number; top: number }> = [];
    for (const attachment of currentChatComments(this.props, this.sessionKey)) {
      const pin = Array.from(this.querySelectorAll<HTMLButtonElement>("button")).find(
        (item) => item.dataset.attachmentId === attachment.id,
      );
      if (!pin) {
        continue;
      }
      const anchor = resolveChatCommentAnchor(this.root, attachment.selectionAnnotation);
      const line = anchor && chatCommentLineEnd(anchor);
      pin.hidden = !line;
      if (!line) {
        continue;
      }
      let left = Math.min(line.right + 4, edge) - origin.left;
      let top = line.top + (line.height - 24) / 2 - origin.top;
      while (
        occupied.some((item) => Math.abs(item.left - left) < 24 && Math.abs(item.top - top) < 24)
      ) {
        if (left + 48 <= edge - origin.left) {
          left += 24;
        } else {
          top += 24;
        }
      }
      occupied.push({ left, top });
      pin.style.left = `${left}px`;
      pin.style.top = `${top}px`;
    }
  }

  protected override render() {
    return repeat(
      currentChatComments(this.props, this.sessionKey),
      (item) => item.id,
      (attachment, index) => html` <button
        type="button"
        class="btn primary chat-comment-pin"
        data-attachment-id=${attachment.id}
        aria-label=${t("chat.messages.editAnnotation", { number: String(index + 1) })}
        title=${attachment.selectionAnnotation.comment || attachment.selectionAnnotation.text}
        ?disabled=${this.props.disabled || this.props.readSignal?.aborted}
        @pointerup=${(event: PointerEvent) => event.stopPropagation()}
        @click=${(event: MouseEvent) => {
          event.stopPropagation();
          if (event.currentTarget instanceof HTMLElement) {
            event.currentTarget.dispatchEvent(
              new CustomEvent("openclaw-comment-action", {
                bubbles: true,
                composed: true,
                detail: { id: attachment.id, action: "edit" },
              }),
            );
          }
        }}
      >
        ${icons.messageSquare}
      </button>`,
    );
  }
}

customElements.define("openclaw-chat-comment-pins", ChatCommentPins);
