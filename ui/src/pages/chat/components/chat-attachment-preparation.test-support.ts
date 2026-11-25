import { createDeferred } from "../../../../../test/helpers/promise.js";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../attachment-payload-store.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { ChatAttachmentReadLifecycle } from "./chat-attachment-reads.ts";

export function createAttachmentDraft(
  attachmentLimits: NonNullable<ChatAttachmentControlsProps["attachmentLimits"]>,
) {
  const reads = new ChatAttachmentReadLifecycle(() => {});
  const readSignal = reads.readSignal;
  const pending: number[] = [];
  const done = createDeferred();
  let attachments: ChatAttachment[] = [];
  const props: ChatAttachmentControlsProps = {
    attachmentReads: reads,
    readSignal,
    attachmentLimits,
    getAttachments: () => attachments,
    onAttachmentsChange: (next) => {
      attachments = next;
    },
    onPendingReadsChange: (delta) => {
      reads.updatePending(readSignal, delta);
      pending.push(reads.pendingReads);
      if (reads.pendingReads === 0) {
        done.resolve();
      }
    },
  };
  const dispose = () => {
    reads.abortReads();
    releaseChatAttachmentPayloads(attachments);
  };
  return { reads, props, attachments: () => attachments, pending, done: done.promise, dispose };
}
