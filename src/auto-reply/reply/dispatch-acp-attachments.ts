import type { AcpTurnAttachment } from "../../acp/control-plane/manager.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { isImageAttachment } from "../../media-understanding/attachments.normalize.js";
import type { MediaAttachment } from "../../media-understanding/types.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { FinalizedMsgContext } from "../templating.js";
import {
  type RecentInboundHistoryImage,
  resolveRecentInboundHistoryImages,
} from "./history-media.js";

const dispatchAcpMediaRuntimeLoader = createLazyImportLoader(
  () => import("./dispatch-acp-media.runtime.js"),
);

export function loadDispatchAcpMediaRuntime() {
  return dispatchAcpMediaRuntimeLoader.load();
}

export type DispatchAcpAttachmentRuntime = Pick<
  Awaited<ReturnType<typeof loadDispatchAcpMediaRuntime>>,
  | "MediaAttachmentCache"
  | "isMediaUnderstandingSkipError"
  | "normalizeAttachments"
  | "resolveMediaAttachmentLocalRoots"
>;

const ACP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ACP_ATTACHMENT_TIMEOUT_MS = 1_000;

export async function resolveAcpTurnAttachments(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  runtime?: DispatchAcpAttachmentRuntime;
}): Promise<{
  attachments: AcpTurnAttachment[];
  recentHistoryImages: RecentInboundHistoryImage[];
}> {
  const runtime = params.runtime ?? (await loadDispatchAcpMediaRuntime());
  const currentAttachments = runtime
    .normalizeAttachments(params.ctx)
    .map((attachment) =>
      normalizeOptionalString(attachment.path)
        ? Object.assign({}, attachment, { url: undefined })
        : attachment,
    );
  const hasCurrentImage = currentAttachments.some(isImageAttachment);
  const recentHistoryImages = hasCurrentImage
    ? []
    : resolveRecentInboundHistoryImages({ ctx: params.ctx });
  const historyAttachments: MediaAttachment[] = recentHistoryImages.map((image, index) => ({
    path: image.path,
    mime: image.contentType,
    index: currentAttachments.length + index,
  }));
  const historyAttachmentByIndex = new Map(
    historyAttachments.map((attachment, index) => [attachment.index, recentHistoryImages[index]]),
  );
  const mediaAttachments = [...currentAttachments, ...historyAttachments];
  const cache = new runtime.MediaAttachmentCache(mediaAttachments, {
    localPathRoots: runtime.resolveMediaAttachmentLocalRoots({
      cfg: params.cfg,
      ctx: params.ctx,
    }),
  });
  const results: AcpTurnAttachment[] = [];
  const resolvedHistoryImages: RecentInboundHistoryImage[] = [];
  for (const attachment of mediaAttachments) {
    const mediaType = attachment.mime ?? "application/octet-stream";
    if (!mediaType.startsWith("image/")) {
      continue;
    }
    if (!normalizeOptionalString(attachment.path)) {
      continue;
    }
    try {
      const { buffer } = await cache.getBuffer({
        attachmentIndex: attachment.index,
        maxBytes: ACP_ATTACHMENT_MAX_BYTES,
        timeoutMs: ACP_ATTACHMENT_TIMEOUT_MS,
      });
      results.push({
        mediaType,
        data: buffer.toString("base64"),
      });
      const historyImage = historyAttachmentByIndex.get(attachment.index);
      if (historyImage) {
        resolvedHistoryImages.push(historyImage);
      }
    } catch (error) {
      if (runtime.isMediaUnderstandingSkipError(error)) {
        logVerbose(`dispatch-acp: skipping attachment #${attachment.index + 1} (${error.reason})`);
      } else {
        const errorName = error instanceof Error ? error.name : typeof error;
        logVerbose(
          `dispatch-acp: failed to read attachment #${attachment.index + 1} (${errorName})`,
        );
      }
    }
  }
  return { attachments: results, recentHistoryImages: resolvedHistoryImages };
}

export async function resolveAcpAttachments(params: {
  ctx: FinalizedMsgContext;
  cfg: OpenClawConfig;
  runtime?: DispatchAcpAttachmentRuntime;
}): Promise<AcpTurnAttachment[]> {
  return (await resolveAcpTurnAttachments(params)).attachments;
}

export function resolveAcpInlineImageAttachments(
  images: Array<{ data: string; mimeType: string }> | undefined,
): AcpTurnAttachment[] {
  if (!Array.isArray(images)) {
    return [];
  }
  return images
    .map((image) => ({
      mediaType: image.mimeType,
      data: image.data,
    }))
    .filter((image) => image.mediaType.startsWith("image/") && image.data.trim().length > 0);
}
