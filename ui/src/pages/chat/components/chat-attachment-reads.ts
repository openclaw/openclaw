import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { uploadsEnabled, uploadsDisabledMessage } from "../../../lib/uploads.ts";
import {
  generateAttachmentId,
  registerChatAttachmentPayload,
} from "../attachment-payload-store.ts";
import {
  admitAttachmentFiles,
  attachmentReservationBytes,
  type ChatAttachmentLimits,
} from "./chat-attachment-admission.ts";
import type { ChatAttachmentControlsProps } from "./chat-attachment-controls.types.ts";
import { resizeChatAttachmentImage } from "./chat-attachment-image.ts";

const CHAT_ATTACHMENT_READ_TIMEOUT_MS = 15_000;

type ChatAttachmentReadDestination = {
  getAttachments: () => ChatAttachment[];
  onAttachmentsChange: (attachments: ChatAttachment[]) => void;
  onPendingReadsChange?: (delta: 1 | -1) => void;
};

export type ChatAttachmentRead = {
  attachment: ChatAttachment;
  state: "reading" | "ready" | "error";
  progress?: number;
  cancel?: () => void;
  destination?: ChatAttachmentReadDestination;
};

type PendingChatAttachmentRead = ChatAttachmentRead & {
  destination: ChatAttachmentReadDestination;
};

export class ChatAttachmentReadLifecycle {
  pendingReads = 0;
  private controller = new AbortController();
  private entries: ChatAttachmentRead[] = [];

  constructor(private notify: () => void) {}

  retarget(destination: ChatAttachmentReadDestination, notify: () => void): void {
    this.notify = notify;
    for (const entry of this.entries) {
      if (entry.destination) {
        entry.destination = destination;
      }
    }
  }

  get readSignal(): AbortSignal {
    return this.controller.signal;
  }

  pendingBytes(limits: ChatAttachmentLimits | undefined): number {
    return this.entries.reduce(
      (total, entry) =>
        total +
        (entry.state === "reading"
          ? attachmentReservationBytes(
              entry.attachment.sizeBytes ?? 0,
              entry.attachment.mimeType,
              limits,
            )
          : 0),
      0,
    );
  }

  updatePending(readSignal: AbortSignal, delta: 1 | -1): void {
    if (this.controller.signal !== readSignal) {
      return;
    }
    this.pendingReads = Math.max(0, this.pendingReads + delta);
    this.notify();
  }

  begin(
    files: readonly File[],
    attachments: ChatAttachment[],
    destination: ChatAttachmentReadDestination,
  ): PendingChatAttachmentRead[] {
    this.project(attachments);
    const entries = files.map((file): PendingChatAttachmentRead => ({
      attachment: {
        id: generateAttachmentId(),
        origin: "file",
        mimeType: file.type || "application/octet-stream",
        fileName: file.name || undefined,
        sizeBytes: file.size,
      },
      state: "reading",
      destination,
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

  settle(entry: ChatAttachmentRead, state: "ready" | "error"): void {
    if (!this.entries.includes(entry)) {
      return;
    }
    entry.state = state;
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

export function readChatAttachmentFile(
  file: File,
  entry: PendingChatAttachmentRead,
  reads: ChatAttachmentReadLifecycle,
  props: Pick<ChatAttachmentControlsProps, "readSignal" | "attachmentLimits" | "uploadConfig">,
): void {
  const signal = props.readSignal ?? reads.readSignal;
  if (signal.aborted) {
    reads.remove(entry);
    return;
  }
  const reader = new FileReader();
  let preparedFile = file;
  const preparation = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = (outcome: "error" | "aborted") => {
    finish(outcome);
    try {
      reader.abort();
    } catch {
      // Ignore reader abort errors on stalled handles.
    }
  };
  const finish = (outcome: "ready" | "error" | "aborted") => {
    if (settled) {
      return;
    }
    settled = true;
    preparation.abort();
    clearTimeout(timer);
    timer = undefined;
    signal.removeEventListener("abort", abort);
    entry.cancel = undefined;
    if (outcome === "ready" && !uploadsEnabled(props.uploadConfig)) {
      showToast({ message: uploadsDisabledMessage() });
      // Keep a failed slot visible rather than silently dropping the rejected file.
      reads.settle(entry, "error");
    } else if (outcome === "ready" && typeof reader.result === "string" && !signal.aborted) {
      const completedAttachment = registerChatAttachmentPayload({
        attachment: entry.attachment,
        dataUrl: reader.result,
        file: preparedFile,
      });
      const ready = [...entry.destination.getAttachments(), completedAttachment];
      const readyIds = new Set(ready.map(({ id }) => id));
      // Publish only readable payloads, in admission order, before releasing send.
      entry.destination.onAttachmentsChange(
        reads
          .project(ready)
          .filter(({ attachment }) => readyIds.has(attachment.id))
          .map(({ attachment }) => attachment),
      );
      reads.settle(entry, "ready");
    } else if (outcome === "aborted" || signal.aborted) {
      reads.remove(entry);
    } else {
      reads.settle(entry, "error");
    }
    entry.destination.onPendingReadsChange?.(-1);
  };
  const abort = () => cancel("aborted");
  const onTimeout = () => cancel("error");
  const setProcessing = (processing: boolean) => {
    clearTimeout(timer);
    timer =
      processing && !settled ? setTimeout(onTimeout, CHAT_ATTACHMENT_READ_TIMEOUT_MS) : undefined;
  };
  entry.cancel = abort;
  signal.addEventListener("abort", abort, { once: true });
  reader.addEventListener("error", () => finish("error"), { once: true });
  reader.addEventListener("abort", () => finish("aborted"), { once: true });
  reader.addEventListener("load", () => finish("ready"), { once: true });
  reader.addEventListener("progress", (event) => {
    if (!settled && event.lengthComputable && event.total > 0) {
      reads.updateProgress(entry, Math.min(1, Math.max(0, event.loaded / event.total)));
      if (timer !== undefined) {
        setProcessing(true);
      }
    }
  });
  entry.destination.onPendingReadsChange?.(1);
  setProcessing(true);
  const readPreparedFile = (prepared: File) => {
    if (settled) {
      return;
    }
    // Intake reserved this file's batch share at its per-file ceiling; preparation can only shrink it.
    if (admitAttachmentFiles([prepared], props.attachmentLimits, 0).length === 0) {
      finish("error");
      return;
    }
    preparedFile = prepared;
    entry.attachment = {
      ...entry.attachment,
      mimeType: prepared.type || "application/octet-stream",
      sizeBytes: prepared.size,
    };
    setProcessing(true);
    try {
      reader.readAsDataURL(prepared);
    } catch {
      finish("error");
    }
  };
  const imageLimit = props.attachmentLimits?.maxImageBytes;
  if (imageLimit !== undefined && file.type.startsWith("image/") && file.size > imageLimit) {
    void resizeChatAttachmentImage(file, imageLimit, preparation.signal, setProcessing).then(
      readPreparedFile,
      () => finish("error"),
    );
  } else {
    readPreparedFile(file);
  }
}
