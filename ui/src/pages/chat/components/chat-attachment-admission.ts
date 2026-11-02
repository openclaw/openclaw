// Per-file ceilings come from policy.attachments; one send's total must also fit a
// single frame (maxBatchBytes from policy.maxPayload). Checking at intake names the file
// instead of failing after the whole batch is base64-encoded. Resizable sources reserve
// their per-file ceiling until preparation completes.
import { resolveChatAttachmentFrameBudgetBytes } from "../../../../../src/shared/chat-attachment-frame-budget.ts";
import type { GatewayHelloOk } from "../../../api/gateway.ts";
import { t } from "../../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../../i18n/locales/en-chat-composer.ts";
import type { ChatAttachment } from "../../../lib/chat/chat-types.ts";
import { showToast } from "../../../lib/toast.ts";
import { getChatAttachmentDataUrl } from "../attachment-payload-store.ts";
import { canResizeChatAttachment } from "./chat-attachment-image.ts";

registerChatComposerEnglish();

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

export function admitAttachmentFiles(
  candidates: readonly File[],
  limits: ChatAttachmentLimits | undefined,
  stagedBytes: number,
  options: {
    resizeImages?: boolean;
    compressVideos?: boolean;
    notify?: boolean;
  } = {},
): File[] {
  const admitted: File[] = [];
  const empty: File[] = [];
  const oversized: File[] = [];
  let total = stagedBytes;
  for (const file of candidates) {
    const compressible = options.compressVideos && file.type.startsWith("video/");
    const reservation = attachmentReservationBytes(
      file.size,
      file.type,
      limits,
      compressible ? (limits?.maxBatchBytes ?? Infinity) - total : Infinity,
    );
    if (file.size === 0) {
      empty.push(file);
    } else if (
      limits &&
      (reservation <= 0 ||
        (file.size > reservation &&
          !compressible &&
          !(options.resizeImages && canResizeChatAttachment(file))) ||
        total + reservation > limits.maxBatchBytes)
    ) {
      oversized.push(file);
    } else {
      admitted.push(file);
      total += reservation;
    }
  }
  if (options.notify !== false && (oversized.length > 0 || empty.length > 0)) {
    showToast({
      message: t(
        oversized.length ? "chat.attachments.tooLargeToast" : "chat.attachments.readFailed",
      ),
      placement: "top-center",
      severity: "error",
    });
  }
  return admitted;
}

export function attachmentReservationBytes(
  sizeBytes: number,
  mimeType: string,
  limits: ChatAttachmentLimits | undefined,
  availableBytes = Infinity,
): number {
  const ceiling = mimeType.startsWith("image/") ? limits?.maxImageBytes : limits?.maxBytes;
  return Math.max(0, Math.min(sizeBytes, ceiling ?? Infinity, availableBytes));
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

export function attachmentBatchRejection(
  attachments: readonly ChatAttachment[],
  policy: ChatAttachmentHelloPolicy | undefined,
): string | undefined {
  const limits = resolveChatAttachmentLimits(policy);
  if (!limits) {
    return undefined;
  }
  let total = 0;
  const oversized = attachments.filter((attachment) => {
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
  return oversized.length > 0
    ? t("chat.attachments.tooLarge", {
        names: oversized
          .slice(0, 3)
          .map((attachment) => {
            const name = attachment.fileName ?? "";
            return name.trim() ? name : t("chat.attachments.attachedFile");
          })
          .join(", "),
        more: oversized.length > 3 ? ` +${oversized.length - 3}` : "",
      })
    : undefined;
}
