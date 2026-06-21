// Builds normalized conversation binding inputs from channel and routing facts.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { normalizeConversationText } from "../../acp/conversation-id.js";
import { resolveConversationBindingContext } from "../../channels/conversation-binding-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import type { MsgContext } from "../templating.js";
import type { HandleCommandsParams } from "./commands-types.js";

type BindingMsgContext = Pick<
  MsgContext,
  | "OriginatingChannel"
  | "Surface"
  | "Provider"
  | "AccountId"
  | "ChatType"
  | "MessageThreadId"
  | "ThreadParentId"
  | "SenderId"
  | "SessionKey"
  | "ParentSessionKey"
  | "OriginatingTo"
  | "To"
  | "From"
  | "NativeChannelId"
>;

function resolveBindingChannel(ctx: BindingMsgContext, commandChannel?: string | null): string {
  const raw = ctx.OriginatingChannel ?? commandChannel ?? ctx.Surface ?? ctx.Provider;
  return normalizeLowercaseStringOrEmpty(normalizeConversationText(raw));
}

function resolveBindingChannelPlugin(ctx: BindingMsgContext, commandChannel?: string | null) {
  const channel = resolveBindingChannel(ctx, commandChannel);
  return getActivePluginChannelRegistry()?.channels.find((entry) => entry.plugin.id === channel)
    ?.plugin;
}

function resolveBindingAccountId(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  const plugin = resolveBindingChannelPlugin(params.ctx, params.commandChannel);
  const accountId = normalizeConversationText(params.ctx.AccountId);
  return (
    accountId ||
    normalizeConversationText(plugin?.config.defaultAccountId?.(params.cfg)) ||
    "default"
  );
}

function resolveBindingThreadId(threadId: string | number | null | undefined): string | undefined {
  const normalized = threadId != null ? normalizeConversationText(String(threadId)) : undefined;
  return normalized || undefined;
}

function resolveConversationBindingContextFromChannelContext(params: {
  cfg: OpenClawConfig;
  ctx: BindingMsgContext;
  senderId?: string | null;
  sessionKey?: string | null;
  parentSessionKey?: string | null;
  commandChannel?: string | null;
  commandTo?: string | null;
}): ReturnType<typeof resolveConversationBindingContext> {
  const channel = resolveBindingChannel(params.ctx, params.commandChannel);
  return resolveConversationBindingContext({
    cfg: params.cfg,
    channel,
    accountId: normalizeConversationText(params.ctx.AccountId) || undefined,
    chatType: params.ctx.ChatType,
    threadId: resolveBindingThreadId(params.ctx.MessageThreadId),
    threadParentId: params.ctx.ThreadParentId,
    senderId: params.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey ?? params.ctx.SessionKey,
    parentSessionKey: params.parentSessionKey ?? params.ctx.ParentSessionKey,
    from: params.ctx.From,
    originatingTo: params.ctx.OriginatingTo,
    commandTo: params.commandTo,
    fallbackTo: params.ctx.To,
    nativeChannelId: params.ctx.NativeChannelId,
  });
}

export function resolveConversationBindingContextFromMessage(params: {
  cfg: OpenClawConfig;
  ctx: BindingMsgContext;
}): ReturnType<typeof resolveConversationBindingContext> {
  return resolveConversationBindingContextFromChannelContext(params);
}

export function resolveConversationBindingContextFromAcpCommand(
  params: HandleCommandsParams,
): ReturnType<typeof resolveConversationBindingContext> {
  return resolveConversationBindingContextFromChannelContext({
    cfg: params.cfg,
    ctx: params.ctx,
    senderId: params.command.senderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    commandChannel: params.command.channel,
    commandTo: params.command.to,
  });
}

/** Resolves plugin command binding APIs only for channels that can identify the current conversation. */
export function resolvePluginCommandConversationBindingContext(
  params: HandleCommandsParams,
): ReturnType<typeof resolveConversationBindingContext> {
  const plugin = resolveBindingChannelPlugin(params.ctx, params.command.channel);
  const supportsCurrentConversationBinding =
    plugin?.conversationBindings?.supportsCurrentConversationBinding === true ||
    plugin?.bindings?.resolveCommandConversation !== undefined;
  if (!supportsCurrentConversationBinding) {
    return null;
  }
  return resolveConversationBindingContextFromAcpCommand(params);
}

export function resolveConversationBindingChannelFromMessage(
  ctx: BindingMsgContext,
  commandChannel?: string | null,
): string {
  return resolveBindingChannel(ctx, commandChannel);
}

export function resolveConversationBindingAccountIdFromMessage(params: {
  ctx: BindingMsgContext;
  cfg: OpenClawConfig;
  commandChannel?: string | null;
}): string {
  return resolveBindingAccountId(params);
}

export function resolveConversationBindingThreadIdFromMessage(
  ctx: Pick<BindingMsgContext, "MessageThreadId">,
): string | undefined {
  return resolveBindingThreadId(ctx.MessageThreadId);
}
