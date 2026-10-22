import type { ChatFileSelection, ChatSelectionSource } from "../../../lib/chat/chat-types.ts";
import { uploadsEnabled } from "../../../lib/uploads.ts";
import { releaseChatAttachmentPayloads } from "../attachment-payload-store.ts";
import { currentAttachments } from "./chat-attachment-draft.ts";
import { stagedAttachmentBytes } from "./chat-attachments.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { createChatSelectionAttachment } from "./chat-selection-attachment.ts";
import { showChatAnnotationEditor, showChatSelectionPopup } from "./chat-selection-popup.tsx";
import type { FileSidebarContent } from "./chat-sidebar-content-types.ts";
import type { ChatDetailPanelProps } from "./chat-sidebar-view-types.ts";

export function offerReaderComment(
  props: ChatDetailPanelProps,
  content: FileSidebarContent,
  selection: ChatSelectionSource & { file: ChatFileSelection },
  range: Range,
  editorSignal: AbortSignal,
  isConnected: () => boolean,
) {
  const chat = props.attachmentChat;
  if (!chat || !content.path) {
    return;
  }
  offerFileComment({
    readChat: () => props.attachmentChat,
    selection: { ...selection, file: { ...selection.file, path: content.path } },
    range,
    signal: chat.readSignal ? AbortSignal.any([editorSignal, chat.readSignal]) : editorSignal,
    isCurrent: () =>
      props.content === content &&
      props.filePresented !== false &&
      !props.fileWorkspace?.showingFolder &&
      isConnected(),
  });
}

/** File readers contribute context; the existing composer owns admission and delivery. */
export function offerFileComment(options: {
  readChat: () => ChatComposerProps | undefined;
  selection: ChatSelectionSource;
  range: Range;
  signal: AbortSignal;
  isCurrent: () => boolean;
}) {
  const { readChat, selection, range, signal, isCurrent } = options;
  const chat = readChat();
  if (!chat) {
    return;
  }
  const enabled = () => {
    const current = readChat();
    return (
      !signal.aborted &&
      isCurrent() &&
      current?.sessionKey === chat.sessionKey &&
      current.readSignal === chat.readSignal &&
      current.gatewayClient === chat.gatewayClient &&
      (current.canCompose ?? current.canSend) &&
      !current.suggestionComposer &&
      uploadsEnabled(current.uploadConfig) &&
      Boolean(current.onAttachmentsChange)
    );
  };
  if (!enabled()) {
    return;
  }
  const anchorRect = range.getBoundingClientRect();
  showChatSelectionPopup(anchorRect, selection, {
    paneId: chat.paneId,
    readSignal: signal,
    onAddToChat: () => {
      if (!enabled()) {
        return;
      }
      showChatAnnotationEditor({
        paneId: chat.paneId,
        anchorRect,
        sourceRange: range,
        comment: "",
        readSignal: signal,
        onSave: (comment) => {
          if (!enabled()) {
            return true;
          }
          const current = readChat()!;
          const attachments = currentAttachments(current);
          const attachment = createChatSelectionAttachment(
            { ...selection, comment, sessionKey: chat.sessionKey },
            current,
            stagedAttachmentBytes(current, attachments),
          );
          if (!attachment) {
            return false;
          }
          if (current.onAttachmentsChange?.([...attachments, attachment]) === false) {
            releaseChatAttachmentPayloads([attachment]);
            return false;
          }
          return true;
        },
      });
    },
  });
}
