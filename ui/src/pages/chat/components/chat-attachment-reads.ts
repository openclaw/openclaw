import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { generateAttachmentId } from "../attachment-payload-store.ts";

export type ChatAttachmentRead = {
  attachment: ChatAttachment;
  state: "reading" | "ready" | "error";
  progress?: number;
  cancel?: () => void;
};

export class ChatAttachmentReadLifecycle {
  pendingReads = 0;
  private controller = new AbortController();
  private entries: ChatAttachmentRead[] = [];

  constructor(private readonly notify: () => void) {}

  get readSignal(): AbortSignal {
    return this.controller.signal;
  }

  updatePending(readSignal: AbortSignal, delta: 1 | -1): void {
    if (this.controller.signal !== readSignal) {
      return;
    }
    this.pendingReads = Math.max(0, this.pendingReads + delta);
    this.notify();
  }

  begin(files: readonly File[], attachments: ChatAttachment[]): ChatAttachmentRead[] {
    this.project(attachments);
    const entries = files.map((file): ChatAttachmentRead => ({
      attachment: {
        id: generateAttachmentId(),
        origin: "file",
        mimeType: file.type || "application/octet-stream",
        fileName: file.name || undefined,
        sizeBytes: file.size,
      },
      state: "reading",
    }));
    this.entries.push(...entries);
    this.notify();
    return entries;
  }

  // Ready payloads remain owned by the composer. Reconcile their membership
  // while retaining unread slots in admission order across overlapping batches.
  project(attachments: readonly ChatAttachment[]): readonly ChatAttachmentRead[] {
    const current = new Map(attachments.map((attachment) => [attachment.id, attachment]));
    this.entries = this.entries.filter((entry) => {
      const attachment = current.get(entry.attachment.id);
      if (attachment) {
        entry.attachment = attachment;
        current.delete(attachment.id);
      }
      return entry.state !== "ready" || attachment !== undefined;
    });
    for (const attachment of current.values()) {
      this.entries.push({ attachment, state: "ready" });
    }
    return this.entries;
  }

  complete(entry: ChatAttachmentRead): void {
    if (!this.entries.includes(entry)) {
      return;
    }
    entry.state = "ready";
    entry.cancel = undefined;
    this.notify();
  }

  fail(entry: ChatAttachmentRead): void {
    if (!this.entries.includes(entry)) {
      return;
    }
    entry.state = "error";
    entry.cancel = undefined;
    this.notify();
  }

  updateProgress(entry: ChatAttachmentRead, fraction: number): void {
    if (!this.entries.includes(entry) || entry.state !== "reading") {
      return;
    }
    entry.progress = fraction;
    this.notify();
  }

  remove(entry: ChatAttachmentRead): void {
    this.entries = this.entries.filter((candidate) => candidate !== entry);
    entry.cancel?.();
    entry.cancel = undefined;
    this.notify();
  }

  abortReads(): void {
    const controller = this.controller;
    this.controller = new AbortController();
    this.entries = [];
    this.pendingReads = 0;
    controller.abort();
    this.notify();
  }
}
