type FeishuConversationParams = {
  ctx: {
    NativeChannelId?: string;
    MessageThreadId?: string | number | null;
    RootMessageId?: string | number | null;
    ThreadParentId?: string;
  };
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    const normalized = String(value).trim();
    return normalized || undefined;
  }
  return undefined;
}

function isThreadScopedConversationId(conversationId: string | undefined): boolean {
  return typeof conversationId === "string" && conversationId.includes(":thread:");
}

export function resolveFeishuConversationId(params: FeishuConversationParams): string | undefined {
  const nativeConversationId = normalizeString(params.ctx.NativeChannelId);
  if (isThreadScopedConversationId(nativeConversationId)) {
    return nativeConversationId;
  }

  const chatId = normalizeString(params.ctx.ThreadParentId);
  const rootMessageId =
    normalizeString(params.ctx.RootMessageId) ?? normalizeString(params.ctx.MessageThreadId);
  if (!chatId || !rootMessageId) {
    return undefined;
  }
  return `${chatId}:thread:${rootMessageId}`;
}
