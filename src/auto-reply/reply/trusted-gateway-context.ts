import crypto from "node:crypto";
import type { MsgContext } from "../templating.js";

export type TrustedGatewayContext = {
  messageId: string;
  messageIds?: string[];
  sender: {
    id?: string;
    userId?: string;
    name?: string;
    username?: string;
    tag?: string;
    e164?: string;
  };
  conversation: {
    id?: string;
    channelId?: string;
    conversationId?: string;
    nativeChannelId?: string;
    to?: string;
    from?: string;
    accountId?: string;
    sessionKey?: string;
    threadId?: string | number;
    parentSessionKey?: string;
    chatType?: string;
  };
  rawText: string;
  source: {
    kind: "gateway-ingress";
    provider?: string;
    surface?: string;
    commandSource?: "text" | "native";
    accountId?: string;
  };
  provenance: {
    kind: "gateway-ingress";
    provider?: string;
    surface?: string;
    messageId: string;
  };
  correlation: {
    correlationId: string;
    operationSeed: string;
  };
  operationContext: {
    operationSeed: string;
    correlationId: string;
    idempotencyKey: string;
  };
};

export type TrustedGatewayActionEnvelope<TModelOutput> = {
  modelOutput: TModelOutput;
  trustedGatewayContext?: TrustedGatewayContext;
};

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const normalized = value.flatMap((entry) => {
    const cleaned = cleanString(entry);
    if (!cleaned || seen.has(cleaned)) {
      return [];
    }
    seen.add(cleaned);
    return [cleaned];
  });
  return normalized.length > 0 ? normalized : undefined;
}

function resolveMessageId(ctx: MsgContext): string | undefined {
  return (
    cleanString(ctx.MessageSidFull) ??
    cleanString(ctx.MessageSidLast) ??
    cleanString(ctx.MessageSid) ??
    cleanString(ctx.MessageSidFirst) ??
    cleanString(ctx.RootMessageId)
  );
}

function resolveMessageIds(ctx: MsgContext, messageId: string): string[] | undefined {
  const messageIds = cleanStringArray(ctx.MessageSids) ?? [];
  if (!messageIds.includes(messageId)) {
    messageIds.push(messageId);
  }
  return messageIds.length > 1 ? messageIds : undefined;
}

function resolveRawText(ctx: MsgContext): string {
  return (
    cleanString(ctx.CommandBody) ??
    cleanString(ctx.RawBody) ??
    cleanString(ctx.BodyForCommands) ??
    cleanString(ctx.BodyForAgent) ??
    cleanString(ctx.Body) ??
    ""
  );
}

function resolveConversationId(ctx: MsgContext): string | undefined {
  return (
    cleanString(ctx.NativeChannelId) ??
    cleanString(ctx.OriginatingTo) ??
    cleanString(ctx.To) ??
    cleanString(ctx.From) ??
    cleanString(ctx.SessionKey)
  );
}

function buildOperationSeed(params: {
  messageId: string;
  messageIds?: string[];
  provider?: string;
  surface?: string;
  accountId?: string;
  senderId?: string;
  conversationId?: string;
  rawText: string;
}): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        messageId: params.messageId,
        messageIds: params.messageIds ?? [],
        provider: params.provider ?? "",
        surface: params.surface ?? "",
        accountId: params.accountId ?? "",
        senderId: params.senderId ?? "",
        conversationId: params.conversationId ?? "",
        rawText: params.rawText,
      }),
    )
    .digest("hex");
}

export function createTrustedGatewayContext(ctx: MsgContext): TrustedGatewayContext | undefined {
  const messageId = resolveMessageId(ctx);
  if (!messageId) {
    return undefined;
  }

  const provider = cleanString(ctx.Provider);
  const surface = cleanString(ctx.Surface);
  const accountId = cleanString(ctx.AccountId);
  const senderId = cleanString(ctx.SenderId);
  const nativeChannelId = cleanString(ctx.NativeChannelId);
  const to = cleanString(ctx.OriginatingTo) ?? cleanString(ctx.To);
  const conversationId = resolveConversationId(ctx);
  const messageIds = resolveMessageIds(ctx, messageId);
  const rawText = resolveRawText(ctx);
  const operationSeed = buildOperationSeed({
    messageId,
    messageIds,
    provider,
    surface,
    accountId,
    senderId,
    conversationId,
    rawText,
  });
  const correlationId = `gw:${operationSeed.slice(0, 32)}`;

  return {
    messageId,
    ...(messageIds ? { messageIds } : {}),
    sender: {
      ...(senderId ? { id: senderId, userId: senderId } : {}),
      ...(cleanString(ctx.SenderName) ? { name: cleanString(ctx.SenderName) } : {}),
      ...(cleanString(ctx.SenderUsername) ? { username: cleanString(ctx.SenderUsername) } : {}),
      ...(cleanString(ctx.SenderTag) ? { tag: cleanString(ctx.SenderTag) } : {}),
      ...(cleanString(ctx.SenderE164) ? { e164: cleanString(ctx.SenderE164) } : {}),
    },
    conversation: {
      ...(conversationId ? { id: conversationId, conversationId } : {}),
      ...(nativeChannelId ? { channelId: nativeChannelId, nativeChannelId } : {}),
      ...(to ? { to } : {}),
      ...(cleanString(ctx.From) ? { from: cleanString(ctx.From) } : {}),
      ...(accountId ? { accountId } : {}),
      ...(cleanString(ctx.SessionKey) ? { sessionKey: cleanString(ctx.SessionKey) } : {}),
      ...(ctx.MessageThreadId != null ? { threadId: ctx.MessageThreadId } : {}),
      ...(cleanString(ctx.ParentSessionKey)
        ? { parentSessionKey: cleanString(ctx.ParentSessionKey) }
        : {}),
      ...(cleanString(ctx.ChatType) ? { chatType: cleanString(ctx.ChatType) } : {}),
    },
    rawText,
    source: {
      kind: "gateway-ingress",
      ...(provider ? { provider } : {}),
      ...(surface ? { surface } : {}),
      ...(ctx.CommandSource ? { commandSource: ctx.CommandSource } : {}),
      ...(accountId ? { accountId } : {}),
    },
    provenance: {
      kind: "gateway-ingress",
      ...(provider ? { provider } : {}),
      ...(surface ? { surface } : {}),
      messageId,
    },
    correlation: {
      correlationId,
      operationSeed,
    },
    operationContext: {
      operationSeed,
      correlationId,
      idempotencyKey: `gateway:${operationSeed}`,
    },
  };
}

export function createTrustedGatewayActionEnvelope<TModelOutput>(params: {
  modelOutput: TModelOutput;
  trustedGatewayContext?: TrustedGatewayContext;
}): TrustedGatewayActionEnvelope<TModelOutput> {
  return {
    modelOutput: params.modelOutput,
    trustedGatewayContext: params.trustedGatewayContext,
  };
}
