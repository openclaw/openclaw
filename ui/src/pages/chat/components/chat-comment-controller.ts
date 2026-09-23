import { nothing, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import { focusWithoutTooltip } from "../../../components/tooltip.ts";
import type { ChatAttachment, ChatSelectionAnnotation } from "../../../lib/chat/chat-types.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { OpenClawLightDomContentsElement } from "../../../lit/openclaw-element.ts";
import { releaseDisplacedChatAttachmentPayloads } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { resolveChatCommentAnchor } from "./chat-comment-anchor.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";
import { showChatAnnotationEditor } from "./chat-selection-popup.ts";

type CommentAttachment = ChatAttachment & { selectionAnnotation: ChatSelectionAnnotation };

export function currentChatComments(props: ChatAttachmentControlsProps, sessionKey: string) {
  return (props.getAttachments?.() ?? props.attachments ?? []).filter(
    (item): item is CommentAttachment =>
      Boolean(
        item.selectionAnnotation &&
        areUiSessionKeysEquivalent(item.selectionAnnotation.sessionKey, sessionKey),
      ),
  );
}

/** Owns comment mutations even when plugins or history errors replace the transcript. */
class ChatCommentController extends OpenClawLightDomContentsElement {
  @property({ attribute: false }) props!: ChatAttachmentControlsProps;
  @property() sessionKey = "";
  @property() paneId = "";
  @property({ type: Boolean }) presented = true;
  private root: HTMLElement | null = null;
  private editorOwner?: AbortController;
  private editingId?: string;
  private editorAnchor?: HTMLElement;
  private editorObserver?: MutationObserver;
  private positionEditor?: () => void;
  private focusFrame?: number;

  override connectedCallback() {
    super.connectedCallback();
    this.requestUpdate("props");
  }

  private currentAttachments() {
    return this.props.getAttachments?.() ?? this.props.attachments ?? [];
  }

  private readonly retireEditor = () => {
    this.editorOwner?.abort();
    this.editorOwner = undefined;
    this.editingId = undefined;
    this.editorAnchor = undefined;
    this.positionEditor = undefined;
    this.editorObserver?.disconnect();
    if (this.focusFrame !== undefined) {
      cancelAnimationFrame(this.focusFrame);
      this.focusFrame = undefined;
    }
  };

  protected override willUpdate(changed: PropertyValues<this>) {
    const previous = changed.get("props");
    if (changed.has("props") && previous?.readSignal !== this.props.readSignal) {
      previous?.readSignal?.removeEventListener("abort", this.retireEditor);
      this.props.readSignal?.addEventListener("abort", this.retireEditor, { once: true });
      this.retireEditor();
    }
    if (
      changed.has("sessionKey") ||
      !this.presented ||
      this.props.disabled ||
      (this.editingId &&
        !currentChatComments(this.props, this.sessionKey).some(
          (item) => item.id === this.editingId,
        ))
    ) {
      this.retireEditor();
    }
  }

  protected override updated() {
    if (!this.root) {
      this.root = this.closest(".chat");
      this.root?.addEventListener("openclaw-comment-action", this.handleCommentAction);
    }
  }

  override disconnectedCallback() {
    this.root?.removeEventListener("openclaw-comment-action", this.handleCommentAction);
    this.root = null;
    this.retireEditor();
    this.props.readSignal?.removeEventListener("abort", this.retireEditor);
    super.disconnectedCallback();
  }

  private canChange(signal: AbortSignal | undefined) {
    return (
      this.isConnected &&
      this.presented &&
      !this.props.disabled &&
      !signal?.aborted &&
      this.props.readSignal === signal &&
      Boolean(this.props.onAttachmentsChange)
    );
  }

  private changeAttachments(current: ChatAttachment[], next: ChatAttachment[]) {
    this.props.onAttachmentsChange?.(next);
    releaseDisplacedChatAttachmentPayloads(current, [next]);
    this.props.onRequestUpdate?.();
  }

  private visiblePin(id: string) {
    return Array.from(this.root?.querySelectorAll<HTMLElement>(".chat-comment-pin") ?? []).find(
      (pin) => {
        if (pin.dataset.attachmentId !== id || pin.hidden) {
          return false;
        }
        const bounds = pin.getBoundingClientRect();
        const thread = pin.closest(".chat-thread")?.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          thread &&
          bounds.top >= Math.max(thread.top, 0) &&
          bounds.bottom <= Math.min(thread.bottom, window.innerHeight) &&
          bounds.left >= Math.max(thread.left, 0) &&
          bounds.right <= Math.min(thread.right, window.innerWidth)
        );
      },
    );
  }

  private readonly handleCommentAction = (event: Event) => {
    if (!(event instanceof CustomEvent) || !this.canChange(this.props.readSignal)) {
      return;
    }
    if (event.detail?.action === "delete-all") {
      event.stopPropagation();
      this.clearComments();
      return;
    }
    const attachment = currentChatComments(this.props, this.sessionKey).find(
      (item) => item.id === event.detail?.id,
    );
    if (!attachment) {
      return;
    }
    event.stopPropagation();
    if (event.detail.action === "delete") {
      const preview =
        event.target instanceof HTMLElement
          ? event.target.closest<HTMLElement>(".chat-comment-preview--editable")
          : null;
      this.deleteComment(attachment.id, preview);
    } else if (event.detail.action === "edit" && event.target instanceof HTMLElement) {
      // Opening must not queue a transcript scroll that would dismiss the editor.
      const trigger = event.target
        .closest("openclaw-tooltip")
        ?.querySelector<HTMLElement>(".chat-selection-annotations__trigger");
      this.editComment(attachment, this.visiblePin(attachment.id) ?? trigger ?? event.target);
    }
  };

  private focusComposer() {
    this.root
      ?.querySelector<HTMLElement>(
        "openclaw-plugin-view[data-plugin-composer], .agent-chat__composer-combobox > textarea",
      )
      ?.focus({ preventScroll: true });
  }

  private clearComments() {
    this.retireEditor();
    const removed = currentChatComments(this.props, this.sessionKey);
    if (removed.length === 0) {
      return;
    }
    const ids = new Set(removed.map((item) => item.id));
    const current = this.currentAttachments();
    this.changeAttachments(
      current,
      current.filter((item) => !ids.has(item.id)),
    );
    this.focusComposer();
  }

  private deleteComment(id: string, preview: HTMLElement | null = null) {
    this.retireEditor();
    const signal = this.props.readSignal;
    const sessionKey = this.sessionKey;
    const comments = currentChatComments(this.props, sessionKey);
    const index = comments.findIndex((item) => item.id === id);
    const next = comments[index + 1] ?? comments[index - 1];
    const current = this.currentAttachments();
    this.changeAttachments(
      current,
      current.filter((item) => item.id !== id),
    );
    if (!preview || !next) {
      this.focusComposer();
      return;
    }
    // Wait for the attachment owner to render the renumbered list before moving focus.
    this.focusFrame = requestAnimationFrame(() => {
      this.focusFrame = undefined;
      if (
        !this.canChange(signal) ||
        this.sessionKey !== sessionKey ||
        !preview.isConnected ||
        !preview.hasAttribute("open")
      ) {
        return;
      }
      preview
        .querySelector<HTMLElement>(`[data-comment-delete="${CSS.escape(next.id)}"]`)
        ?.focus({ preventScroll: true });
    });
  }

  private readonly syncEditorAnchor = () => {
    if (!this.editorAnchor?.isConnected || this.editorAnchor.hidden) {
      this.retireEditor();
    } else {
      this.positionEditor?.();
    }
  };

  private editComment(attachment: CommentAttachment, anchor: HTMLElement) {
    const signal = this.props.readSignal;
    if (!this.canChange(signal)) {
      return;
    }
    this.retireEditor();
    this.editorOwner = new AbortController();
    this.editingId = attachment.id;
    this.editorAnchor = anchor;
    this.positionEditor = showChatAnnotationEditor({
      paneId: this.paneId,
      anchorRect: anchor.getBoundingClientRect(),
      anchorElement: anchor,
      sourceRange: this.root
        ? resolveChatCommentAnchor(this.root, attachment.selectionAnnotation)?.range
        : undefined,
      comment: attachment.selectionAnnotation.comment,
      expanded: true,
      readSignal: this.editorOwner.signal,
      onSave: (comment) => {
        if (!this.canChange(signal)) {
          return true;
        }
        const current = this.currentAttachments();
        const selected = current.find((item) => item.id === attachment.id);
        if (!selected?.selectionAnnotation) {
          return true;
        }
        const replacement = createChatSelectionAttachment(
          { ...selected.selectionAnnotation, comment },
          this.props.attachmentLimits,
        );
        if (!replacement) {
          return false;
        }
        this.changeAttachments(
          current,
          current.map((item) => (item.id === attachment.id ? replacement : item)),
        );
        this.retireEditor();
        this.focusFrame = requestAnimationFrame(() => {
          this.focusFrame = undefined;
          if (this.canChange(signal)) {
            const target = this.visiblePin(replacement.id) ?? (anchor.isConnected ? anchor : null);
            if (target) {
              focusWithoutTooltip(target);
            } else {
              this.focusComposer();
            }
          }
        });
        return true;
      },
      onDelete: () => {
        if (this.canChange(signal)) {
          this.deleteComment(attachment.id);
        }
      },
      onCancel: () => {
        this.retireEditor();
        focusWithoutTooltip(anchor);
      },
    });
    if (this.root) {
      this.editorObserver ??= new MutationObserver(this.syncEditorAnchor);
      this.editorObserver.observe(this.root, { childList: true, subtree: true, attributes: true });
    }
  }

  protected override render() {
    return nothing;
  }
}

customElements.define("openclaw-chat-comment-controller", ChatCommentController);
