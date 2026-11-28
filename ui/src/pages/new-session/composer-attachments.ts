import { resolveChatAttachmentLimits } from "../chat/components/chat-attachment-admission.ts";
import { createChatAttachmentDropHandlers } from "../chat/components/chat-attachments.ts";
import type { NewSessionComposerOptions } from "./composer-options.ts";

/** Keep file reads and their callbacks bound to the frame's captured draft signal. */
export function createNewSessionAttachmentControls(
  options: NewSessionComposerOptions,
  composerLocked: boolean,
) {
  const { attachmentDraft, context } = options;
  const readSignal = attachmentDraft.reads.readSignal;
  const attachmentProps = {
    attachmentReads: attachmentDraft.reads,
    attachmentLimits: resolveChatAttachmentLimits(context?.gateway.snapshot.hello?.policy),
    uploadConfig: context?.config,
    attachments: attachmentDraft.attachments,
    get disabled() {
      return (
        options.submitting || options.messageLocked === true || options.dictationActive === true
      );
    },
    getAttachments: () => attachmentDraft.attachments,
    draft: options.message,
    getDraft: () => options.message,
    onAttachmentsChange: (attachments: typeof attachmentDraft.attachments) => {
      if (!options.submitting && !options.messageLocked) {
        attachmentDraft.replace(attachments);
      }
    },
    onDraftChange: options.onInput,
    onPendingReadsChange: (delta: 1 | -1) => attachmentDraft.reads.updatePending(readSignal, delta),
    onOpenImage: options.onOpenImage,
    onOpenSidebar: options.onOpenSidebar,
    readSignal,
  };
  return {
    attachmentProps,
    attachmentDropHandlers: createChatAttachmentDropHandlers({
      ...attachmentProps,
      canCompose: !composerLocked && !options.nativeTerminal,
    }),
  };
}
