// Admit batches before base64 encoding to avoid disconnecting every pane with WS 1009.
// Resizable sources reserve their per-file ceiling until preparation completes.
import { resolveChatAttachmentFrameBudgetBytes } from "../../../../../src/shared/chat-attachment-frame-budget.ts";
import type { GatewayHelloOk } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";
import { canResizeChatAttachment } from "./chat-attachment-image.ts";

export type ChatAttachmentLimits = {
  maxBytes: number;
  maxImageBytes: number;
  maxBatchBytes: number;
};

type ChatAttachmentHelloPolicy = NonNullable<GatewayHelloOk["policy"]>;

const limitsByPolicy = new WeakMap<ChatAttachmentHelloPolicy, ChatAttachmentLimits>();

export function resolveChatAttachmentLimits(
  policy: ChatAttachmentHelloPolicy | undefined,
): ChatAttachmentLimits | undefined {
  if (!policy?.attachments) {
    return undefined;
  }
  let limits = limitsByPolicy.get(policy);
  if (!limits) {
    limits = {
      ...policy.attachments,
      maxBatchBytes: resolveChatAttachmentFrameBudgetBytes(policy.maxPayload ?? Infinity),
    };
    limitsByPolicy.set(policy, limits);
  }
  return limits;
}

function skippedFilesMessage(messageKey: string, names: readonly string[]): string {
  return t(messageKey, {
    names: names
      .slice(0, 3)
      .map((name) => (name.trim() ? name : t("chat.attachments.attachedFile")))
      .join(", "),
    more: names.length > 3 ? ` +${names.length - 3}` : "",
  });
}

function skippedFilesToast(messageKey: string, skipped: readonly File[]): void {
  if (skipped.length === 0) {
    return;
  }
  showToast({
    message: skippedFilesMessage(
      messageKey,
      skipped.map((file) => file.name),
    ),
  });
}

export function admitAttachmentFiles(
  candidates: readonly File[],
  limits: ChatAttachmentLimits | undefined,
  stagedBytes: number,
  options: { resizeImages?: boolean } = {},
): File[] {
  const admitted: File[] = [];
  const empty: File[] = [];
  const oversized: File[] = [];
  let total = stagedBytes;
  for (const file of candidates) {
    const reservation = attachmentReservationBytes(file.size, file.type, limits);
    if (file.size === 0) {
      empty.push(file);
    } else if (
      limits &&
      ((file.size > reservation && !(options.resizeImages && canResizeChatAttachment(file))) ||
        total + reservation > limits.maxBatchBytes)
    ) {
      oversized.push(file);
    } else {
      admitted.push(file);
      total += reservation;
    }
  }
  skippedFilesToast("chat.attachments.readFailed", empty);
  skippedFilesToast("chat.attachments.tooLarge", oversized);
  return admitted;
}

export function attachmentReservationBytes(
  sizeBytes: number,
  mimeType: string,
  limits: ChatAttachmentLimits | undefined,
): number {
  const ceiling = mimeType.startsWith("image/") ? limits?.maxImageBytes : limits?.maxBytes;
  return Math.min(sizeBytes, ceiling ?? Infinity);
}

function attachmentBytes(attachment: ChatAttachment): number {
  const size = attachment.sizeBytes;
  if (typeof size === "number" && Number.isFinite(size) && size >= 0) {
    return size;
  }
  const dataUrl = getChatAttachmentDataUrl(attachment);
  const payload = dataUrl?.match(/^data:[^,]*;base64,([\s\S]*)$/i)?.[1]?.replace(/\s/g, "");
  return payload
    ? Math.max(0, Math.floor((payload.length * 3) / 4) - (payload.match(/=+$/)?.[0].length ?? 0))
    : 0;
}

export function chatAttachmentBatchBytes(attachments: readonly ChatAttachment[]): number {
  return attachments.reduce((total, attachment) => total + attachmentBytes(attachment), 0);
}

function oversizedAttachmentBatch(
  attachments: readonly ChatAttachment[],
  limits: ChatAttachmentLimits | undefined,
): ChatAttachment[] {
  if (!limits) {
    return [];
  }
  let total = 0;
  return attachments.filter((attachment) => {
    const size = attachmentBytes(attachment);
    const ceiling = attachment.mimeType.startsWith("image/")
      ? limits.maxImageBytes
      : limits.maxBytes;
    if (size > ceiling || total + size > limits.maxBatchBytes) {
      return true;
    }
    total += size;
    return false;
  });
}

export function attachmentBatchRejection(
  attachments: readonly ChatAttachment[],
  policy: ChatAttachmentHelloPolicy | undefined,
): string | undefined {
  const oversized = oversizedAttachmentBatch(attachments, resolveChatAttachmentLimits(policy));
  return oversized.length > 0
    ? skippedFilesMessage(
        "chat.attachments.tooLarge",
        oversized.map((attachment) => attachment.fileName ?? ""),
      )
    : undefined;
}
