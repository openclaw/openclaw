type FeishuConversationParams = {
  ctx: {
    MessageThreadId?: string | number | null;
    OriginatingTo?: string;
    To?: string;
  };
  command: {
    to?: string;
  };
};

function normalizeFeishuTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const lowered = trimmed.toLowerCase();
  // Strip common Feishu target prefixes to get the raw ID.
  for (const prefix of ["chat:", "group:", "channel:", "user:", "dm:", "open_id:"]) {
    if (lowered.startsWith(prefix)) {
      const id = trimmed.slice(prefix.length).trim();
      return id || null;
    }
  }
  return trimmed;
}

export function resolveFeishuConversationId(params: FeishuConversationParams): string | undefined {
  const rawThreadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  const threadId = rawThreadId || undefined;
  const toCandidates = [
    typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo : "",
    typeof params.command.to === "string" ? params.command.to : "",
    typeof params.ctx.To === "string" ? params.ctx.To : "",
  ]
    .map((value) => value.trim())
    .filter(Boolean);
  const chatId = toCandidates
    .map((candidate) => normalizeFeishuTarget(candidate))
    .find((candidate) => candidate != null && candidate.length > 0);
  if (!chatId) {
    return undefined;
  }
  if (threadId) {
    return `${chatId}:topic:${threadId}`;
  }
  // Group chats (oc_ prefix) without a topic should not become globally focused.
  if (chatId.startsWith("oc_")) {
    return undefined;
  }
  // DM conversations (ou_ prefix or other IDs) are allowed.
  return chatId;
}
