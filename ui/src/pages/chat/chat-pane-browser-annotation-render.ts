import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { showToast } from "../../lib/toast.ts";
import { releaseChatAttachmentPayload } from "./attachment-payload-store.ts";
import { canAdmitBrowserAnnotation } from "./browser-annotation-admission.ts";
import { ChatPaneHeader } from "./chat-pane-header.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";

export abstract class ChatPaneBrowserAnnotationRender extends ChatPaneHeader {
  private browserAnnotationFocus = new Map<string, HTMLButtonElement>();
  protected readonly registerBrowserAnnotationFocus = (
    attachmentId: string,
    button: HTMLButtonElement,
  ) => {
    this.browserAnnotationFocus.set(attachmentId, button);
    return () => {
      if (this.browserAnnotationFocus.get(attachmentId) === button) {
        this.browserAnnotationFocus.delete(attachmentId);
      }
    };
  };
  protected readonly removeBrowserAnnotation = (attachment: ChatAttachment) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const sourceSessionKey = state.sessionKey;
    const focusAfterUpdate = (target: () => HTMLElement | null | undefined) => {
      void this.awaitDomCommit().then(() => {
        if (this.state === state && this.state.sessionKey === sourceSessionKey) {
          target()?.focus({ preventScroll: true });
        }
      });
    };
    const labels = {
      removed: t("chat.composer.browserAnnotationRemoved"),
      undo: t("common.undo"),
      undoUnavailable: t("chat.composer.browserAnnotationUndoUnavailable"),
    };
    if (!attachment.browserAnnotation) {
      return;
    }
    const modelContext = attachment.browserAnnotation.modelContext;
    const sourceOwner = this.stagedAttachmentGatewayOwner ?? undefined;
    const removalSessionKey = this.state?.sessionKey ?? "";
    const current = this.state?.chatAttachments ?? [];
    const sourceIndex = current.findIndex((candidate) => candidate.id === attachment.id);
    if (sourceIndex < 0) {
      return;
    }

    const remaining = current.filter((candidate) => candidate.id !== attachment.id);
    if (this.state) {
      this.chatState.attachmentInputProps(this.state).onAttachmentsChange(remaining);
    }
    focusAfterUpdate(() => getChatComposerState(this.presentationId).composerTextarea);

    let settled = false;
    const finalizeRemoval = () => {
      if (settled) {
        return;
      }
      settled = true;
      releaseChatAttachmentPayload(attachment.id);
    };
    const presented = showToast({
      message: labels.removed,
      actionLabel: labels.undo,
      onAction: () => {
        if (settled) {
          return;
        }
        if (
          (this.stagedAttachmentGatewayOwner ?? undefined) !== sourceOwner ||
          (this.state?.sessionKey ?? "") !== removalSessionKey
        ) {
          finalizeRemoval();
          return;
        }
        const latest = this.state?.chatAttachments ?? [];
        if (latest.some((candidate) => candidate.id === attachment.id)) {
          settled = true;
          return;
        }
        if (!canAdmitBrowserAnnotation(latest, modelContext)) {
          finalizeRemoval();
          showToast({ message: labels.undoUnavailable });
          return;
        }
        settled = true;
        const restored = [...latest];
        restored.splice(Math.min(sourceIndex, latest.length), 0, attachment);
        if (this.state) {
          this.chatState.attachmentInputProps(this.state).onAttachmentsChange(restored);
        }
        const attachmentId = attachment.id;
        focusAfterUpdate(() => this.browserAnnotationFocus.get(attachmentId));
      },
      onDismiss: (reason) => {
        if (reason !== "action") {
          finalizeRemoval();
        }
      },
    });
    if (!presented) {
      finalizeRemoval();
    }
  };
}
