import type { vi } from "vitest";

export function createDispatchConversationBindingMocks(mock: Pick<typeof vi, "fn">) {
  type BindingMsgContext = {
    OriginatingChannel?: string | null;
    Surface?: string | null;
    Provider?: string | null;
    AccountId?: string | null;
    MessageThreadId?: string | number | null;
    ThreadParentId?: string | null;
    SenderId?: string | null;
    SessionKey?: string | null;
    ParentSessionKey?: string | null;
    OriginatingTo?: string | null;
    To?: string | null;
    From?: string | null;
    NativeChannelId?: string | null;
  };
  type BindingConfig = {
    channels?: Record<string, { defaultAccount?: string | null } | undefined>;
  };

  const normalizeText = (value: string | number | null | undefined) =>
    typeof value === "number" ? `${value}` : (value ?? "").trim();
  const normalizeChannel = (value: string | null | undefined) => normalizeText(value).toLowerCase();
  const resolveChannel = (ctx: BindingMsgContext, commandChannel?: string | null) =>
    normalizeChannel(ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider);
  const resolveAccountId = (ctx: BindingMsgContext, cfg: BindingConfig, channel: string) =>
    normalizeText(ctx.AccountId) ||
    normalizeText(cfg.channels?.[channel]?.defaultAccount) ||
    "default";
  const resolveTarget = (channel: string, value: string | null | undefined) => {
    const target = normalizeText(value);
    if (!target) {
      return undefined;
    }
    const channelPrefix = `${channel}:`;
    return target.toLowerCase().startsWith(channelPrefix)
      ? target.slice(channelPrefix.length)
      : target;
  };
  const resolveThreadId = (ctx: BindingMsgContext) =>
    normalizeText(ctx.MessageThreadId) || undefined;

  const resolveConversationBindingContextFromMessage = mock.fn(
    (params: { cfg: BindingConfig; ctx: BindingMsgContext }) => {
      const channel = resolveChannel(params.ctx);
      if (!channel) {
        return null;
      }
      const threadId = resolveThreadId(params.ctx);
      const baseConversationId =
        resolveTarget(channel, params.ctx.OriginatingTo) ?? resolveTarget(channel, params.ctx.To);
      const conversationId = threadId ?? baseConversationId;
      if (!conversationId) {
        return null;
      }
      const rawThreadParentId = resolveTarget(channel, params.ctx.ThreadParentId);
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
        accountId: resolveAccountId(params.ctx, params.cfg, channel),
        conversationId,
        ...(parentConversationId ? { parentConversationId } : {}),
        ...(threadId ? { threadId } : {}),
      };
    },
  );

  return {
    resolveConversationBindingAccountIdFromMessage: (params: {
      ctx: BindingMsgContext;
      cfg: BindingConfig;
      commandChannel?: string | null;
    }) =>
      resolveAccountId(params.ctx, params.cfg, resolveChannel(params.ctx, params.commandChannel)),
    resolveConversationBindingChannelFromMessage: (
      ctx: BindingMsgContext,
      commandChannel?: string | null,
    ) => resolveChannel(ctx, commandChannel),
    resolveConversationBindingContextFromAcpCommand: (params: {
      cfg: BindingConfig;
      ctx: BindingMsgContext;
      command?: { to?: string | null; senderId?: string | null };
      sessionKey?: string | null;
      parentSessionKey?: string | null;
    }) =>
      resolveConversationBindingContextFromMessage({
        cfg: params.cfg,
        ctx: {
          ...params.ctx,
          SenderId: params.command?.senderId ?? params.ctx.SenderId,
          SessionKey: params.sessionKey ?? params.ctx.SessionKey,
          ParentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
          To: params.command?.to ?? params.ctx.To,
        },
      }),
    resolveConversationBindingContextFromMessage,
    resolveConversationBindingThreadIdFromMessage: (ctx: BindingMsgContext) => resolveThreadId(ctx),
  };
}
