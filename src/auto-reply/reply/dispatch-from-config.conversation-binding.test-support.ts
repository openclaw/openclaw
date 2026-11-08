import type { vi } from "vitest";

export function createDispatchConversationBindingMocks(mock: Pick<typeof vi, "fn">) {
  type BindingMsgContext = {
    OriginatingChannel?: string | null;
    Surface?: string | null;
    Provider?: string | null;
    AccountId?: string | null;
    MessageThreadId?: string | number | null;
    ThreadParentId?: string | null;
    OriginatingTo?: string | null;
    To?: string | null;
  };
  type BindingConfig = {
    channels?: Record<string, { defaultAccount?: string | null } | undefined>;
  };
  type BindingInput = {
    ctx: BindingMsgContext;
    cfg: BindingConfig;
    commandChannel?: string | null;
    command?: { to?: string | null };
  };

  const normalizeText = (value: string | number | null | undefined) =>
    typeof value === "number" ? `${value}` : (value ?? "").trim();
  const resolveChannel = (ctx: BindingMsgContext, commandChannel?: string | null) =>
    normalizeText(
      ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider,
    ).toLowerCase();
  const resolveAccountId = (ctx: BindingMsgContext, cfg: BindingConfig, channel: string) =>
    normalizeText(ctx.AccountId) ||
    normalizeText(cfg.channels?.[channel]?.defaultAccount) ||
    "default";
  const resolveTarget = (channel: string, value: string | null | undefined) => {
    const target = normalizeText(value) || undefined;
    return target?.toLowerCase().startsWith(`${channel}:`)
      ? target.slice(channel.length + 1)
      : target;
  };

  const resolveConversationBindingContextFromMessage = mock.fn(({ cfg, ctx }: BindingInput) => {
    const channel = resolveChannel(ctx);
    const threadId = normalizeText(ctx.MessageThreadId) || undefined;
    const baseConversationId =
      resolveTarget(channel, ctx.OriginatingTo) ?? resolveTarget(channel, ctx.To);
    const conversationId = threadId ?? baseConversationId;
    if (!channel || !conversationId) {
      return null;
    }
    const rawThreadParentId = resolveTarget(channel, ctx.ThreadParentId);
    const explicitThreadParentId =
      channel === "discord" && rawThreadParentId && !rawThreadParentId.includes(":")
        ? `channel:${rawThreadParentId}`
        : rawThreadParentId;
    const parentConversationId =
      explicitThreadParentId ??
      (threadId && baseConversationId && baseConversationId !== threadId
        ? baseConversationId
        : undefined);
    return {
      channel,
      accountId: resolveAccountId(ctx, cfg, channel),
      conversationId,
      ...(parentConversationId ? { parentConversationId } : {}),
      ...(threadId ? { threadId } : {}),
    };
  });

  return {
    resolveConversationBindingAccountIdFromMessage: ({ ctx, cfg, commandChannel }: BindingInput) =>
      resolveAccountId(ctx, cfg, resolveChannel(ctx, commandChannel)),
    resolveConversationBindingChannelFromMessage: resolveChannel,
    resolveConversationBindingContextFromAcpCommand: ({ cfg, ctx, command }: BindingInput) =>
      resolveConversationBindingContextFromMessage({
        cfg,
        ctx: { ...ctx, To: command?.to ?? ctx.To },
      }),
    resolveConversationBindingContextFromMessage,
  };
}
