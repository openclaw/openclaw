import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { removeBrowserAnnotationWithUndo } from "./browser-annotation-removal.ts";
import { ChatPaneHeader } from "./chat-pane-header.ts";
import { getChatComposerState } from "./components/chat-composer-state.ts";

export abstract class ChatPaneBrowserAnnotationRender extends ChatPaneHeader {
  protected readonly removeBrowserAnnotation = (attachment: ChatAttachment) => {
    const state = this.state;
    if (!state) {
      return;
    }
    const sourceSessionKey = state.sessionKey;
    const focusAfterUpdate = (target: () => HTMLElement | null | undefined) => {
      void this.updateComplete.then(() => {
        if (this.state === state && this.state.sessionKey === sourceSessionKey) {
          target()?.focus({ preventScroll: true });
        }
      });
    };
    removeBrowserAnnotationWithUndo(
      {
        getOwner: () => this.stagedAttachmentGatewayOwner ?? undefined,
        getSessionKey: () => this.state?.sessionKey ?? "",
        getAttachments: () => this.state?.chatAttachments ?? [],
        setAttachments: (attachments) => {
          if (this.state) {
            this.state.chatAttachments = attachments;
          }
        },
        requestUpdate: () => this.state?.requestUpdate?.(),
        focusComposer: () =>
          focusAfterUpdate(() => getChatComposerState(this.presentationId).composerTextarea),
        // Restored attachment cards own their controls; resolve after the card commits.
        focusRestoredAnnotation: (attachmentId) =>
          focusAfterUpdate(() => {
            const card = [
              ...this.element.querySelectorAll<HTMLElement>("[data-attachment-id]"),
            ].find((candidate) => candidate.dataset.attachmentId === attachmentId);
            return card?.querySelector<HTMLButtonElement>("button");
          }),
      },
      attachment,
      {
        removed: t("chat.composer.browserAnnotationRemoved"),
        undo: t("common.undo"),
        undoUnavailable: t("chat.composer.browserAnnotationUndoUnavailable"),
      },
    );
  };
}
