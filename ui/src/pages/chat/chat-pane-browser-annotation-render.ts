import { t } from "../../i18n/index.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { removeBrowserAnnotationWithUndo } from "./browser-annotation-removal.ts";
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
    removeBrowserAnnotationWithUndo(
      {
        getOwner: () => this.stagedAttachmentGatewayOwner ?? undefined,
        getSessionKey: () => this.state?.sessionKey ?? "",
        getAttachments: () => this.state?.chatAttachments ?? [],
        setAttachments: (attachments) => {
          if (this.state) {
            this.chatState.attachmentInputProps(this.state).onAttachmentsChange(attachments);
          }
        },
        focusComposer: () =>
          focusAfterUpdate(() => getChatComposerState(this.presentationId).composerTextarea),
        focusRestoredAnnotation: (attachmentId) =>
          focusAfterUpdate(() => this.browserAnnotationFocus.get(attachmentId)),
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
