import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import {
  releaseChatAttachmentPayloads,
  releaseDisplacedChatAttachmentPayloads,
} from "../chat/attachment-payload-store.ts";
import { ChatAttachmentReadLifecycle } from "../chat/components/chat-attachment-reads.ts";

export class NewSessionAttachmentDraft {
  attachments: ChatAttachment[] = [];
  readonly reads: ChatAttachmentReadLifecycle;

  constructor(
    private readonly notify: () => void,
    private readonly onUserChange: () => void,
  ) {
    this.reads = new ChatAttachmentReadLifecycle(notify);
  }

  replace(attachments: ChatAttachment[]) {
    this.attachments = attachments;
    this.onUserChange();
    this.notify();
  }

  restore(attachments: ChatAttachment[]) {
    releaseDisplacedChatAttachmentPayloads(this.attachments, [attachments]);
    this.attachments = attachments;
    this.notify();
  }

  take(): ChatAttachment[] {
    this.reads.abortReads();
    const attachments = this.attachments;
    this.attachments = [];
    this.notify();
    return attachments;
  }

  reset(options: { release: boolean }) {
    this.reads.abortReads();
    this.clearAfterSubmit(options.release);
  }

  clearAfterSubmit(release: boolean) {
    if (release) {
      releaseChatAttachmentPayloads(this.attachments);
    }
    this.attachments = [];
    this.notify();
  }
}
