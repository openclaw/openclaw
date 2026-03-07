export type OutboundReplyPayload = {
  text?: string;
  mediaUrls?: string[];
  mediaUrl?: string;
  replyToId?: string;
};

export function normalizeOutboundReplyPayload(
  payload: Record<string, unknown>,
): OutboundReplyPayload {
  const text = typeof payload.text === "string" ? payload.text : undefined;
  const mediaUrls = Array.isArray(payload.mediaUrls)
    ? payload.mediaUrls.filter(
        (entry): entry is string => typeof entry === "string" && entry.length > 0,
      )
    : undefined;
  const mediaUrl = typeof payload.mediaUrl === "string" ? payload.mediaUrl : undefined;
  const replyToId = typeof payload.replyToId === "string" ? payload.replyToId : undefined;
  return {
    text,
    mediaUrls,
    mediaUrl,
    replyToId,
  };
}

export function createNormalizedOutboundDeliverer(
  handler: (payload: OutboundReplyPayload) => Promise<void>,
): (payload: unknown) => Promise<void> {
  return async (payload: unknown) => {
    const normalized =
      payload && typeof payload === "object"
        ? normalizeOutboundReplyPayload(payload as Record<string, unknown>)
        : {};
    await handler(normalized);
  };
}

export function resolveOutboundMediaUrls(payload: {
  mediaUrls?: string[];
  mediaUrl?: string;
}): string[] {
  if (payload.mediaUrls?.length) {
    return payload.mediaUrls;
  }
  if (payload.mediaUrl) {
    return [payload.mediaUrl];
  }
  return [];
}

export async function sendPayloadWithChunkedTextAndMedia<
  TContext extends { payload: object },
  TResult,
>(params: {
  ctx: TContext;
  textChunkLimit?: number;
  chunker?: ((text: string, limit: number) => string[]) | null;
  sendText: (ctx: TContext & { text: string }) => Promise<TResult>;
  sendMedia: (ctx: TContext & { text: string; mediaUrl: string }) => Promise<TResult>;
  emptyResult: TResult;
}): Promise<TResult> {
  const payload = params.ctx.payload as { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  const text = payload.text ?? "";
  const urls = resolveOutboundMediaUrls(payload);
  if (!text && urls.length === 0) {
    return params.emptyResult;
  }
  if (urls.length > 0) {
    let lastResult = await params.sendMedia({
      ...params.ctx,
      text,
      mediaUrl: urls[0],
    });
    for (let i = 1; i < urls.length; i++) {
      lastResult = await params.sendMedia({
        ...params.ctx,
        text: "",
        mediaUrl: urls[i],
      });
    }
    return lastResult;
  }
  const limit = params.textChunkLimit;
  const chunks = limit && params.chunker ? params.chunker(text, limit) : [text];
  let lastResult: TResult;
  for (const chunk of chunks) {
    lastResult = await params.sendText({ ...params.ctx, text: chunk });
  }
  return lastResult!;
}

export function isNumericTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return /^\d{3,}$/.test(trimmed);
}

export function formatTextWithAttachmentLinks(
  text: string | undefined,
  mediaUrls: string[],
): string {
  const trimmedText = text?.trim() ?? "";
  if (!trimmedText && mediaUrls.length === 0) {
    return "";
  }
  const mediaBlock = mediaUrls.length
    ? mediaUrls.map((url) => `Attachment: ${url}`).join("\n")
    : "";
  if (!trimmedText) {
    return mediaBlock;
  }
  if (!mediaBlock) {
    return trimmedText;
  }
  return `${trimmedText}\n\n${mediaBlock}`;
}

export async function sendMediaWithLeadingCaption(params: {
  mediaUrls: string[];
  caption: string;
  send: (payload: { mediaUrl: string; caption?: string }) => Promise<void>;
  onError?: (error: unknown, mediaUrl: string) => void;
}): Promise<boolean> {
  if (params.mediaUrls.length === 0) {
    return false;
  }

  let first = true;
  for (const mediaUrl of params.mediaUrls) {
    const caption = first ? params.caption : undefined;
    first = false;
    try {
      await params.send({ mediaUrl, caption });
    } catch (error) {
      if (params.onError) {
        params.onError(error, mediaUrl);
        continue;
      }
      throw error;
    }
  }
  return true;
}
