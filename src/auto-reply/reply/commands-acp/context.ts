import { resolveSpawnOrigin, type SpawnOrigin } from "../../../agents/acp-spawn-origin.js";
import { DISCORD_THREAD_BINDING_CHANNEL } from "../../../channels/thread-bindings-policy.js";
import { canonicalizeConversationContext } from "../../../infra/outbound/conversation-canonical.js";
import type { HandleCommandsParams } from "../commands-types.js";

function normalizeText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return `${value}`.trim();
  }
  return "";
}

function isAcpBindingTargetCandidate(value: string): boolean {
  // Native slash commands route interaction replies through slash:<user>,
  // but ACP thread binding must resolve the underlying conversation target.
  return !/^slash:/i.test(value);
}

function resolveAcpCommandToCandidates(params: HandleCommandsParams): string[] {
  return [params.ctx.OriginatingTo, params.command.to, params.ctx.To]
    .map((value) => normalizeText(value))
    .filter(Boolean)
    .filter((value) => isAcpBindingTargetCandidate(value));
}

function resolveAcpCommandCanonicalConversation(params: HandleCommandsParams) {
  return canonicalizeConversationContext({
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    targets: resolveAcpCommandToCandidates(params),
    senderId: params.command.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    threadParentId: normalizeText(params.ctx.ThreadParentId) || undefined,
  });
}

export function resolveAcpCommandChannel(params: HandleCommandsParams): string {
  const raw =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeText(raw).toLowerCase();
}

export function resolveAcpCommandAccountId(params: HandleCommandsParams): string {
  return normalizeText(params.ctx.AccountId) || "default";
}

export function resolveAcpCommandThreadId(params: HandleCommandsParams): string | undefined {
  const threadId =
    params.ctx.MessageThreadId != null ? normalizeText(String(params.ctx.MessageThreadId)) : "";
  return threadId || undefined;
}

export function resolveAcpCommandConversationId(params: HandleCommandsParams): string | undefined {
  const channel = resolveAcpCommandChannel(params);
  const conversation = resolveAcpCommandCanonicalConversation(params);
  if ((channel === "telegram" || channel === "feishu") && !conversation.currentBindingEligible) {
    return undefined;
  }
  return conversation.conversationId;
}

export function resolveAcpCommandParentConversationId(
  params: HandleCommandsParams,
): string | undefined {
  return resolveAcpCommandCanonicalConversation(params).parentConversationId;
}

export function isAcpCommandDiscordChannel(params: HandleCommandsParams): boolean {
  return resolveAcpCommandChannel(params) === DISCORD_THREAD_BINDING_CHANNEL;
}

export function resolveAcpCommandSpawnOrigin(
  params: HandleCommandsParams,
): { ok: true; origin: SpawnOrigin } | { ok: false; error: string } {
  const deliveryTo = resolveAcpCommandToCandidates(params)[0];
  return resolveSpawnOrigin({
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    deliveryTo,
    deliveryThreadId: resolveAcpCommandThreadId(params),
    targets: resolveAcpCommandToCandidates(params),
    senderId: params.command.senderId ?? params.ctx.SenderId,
    sessionKey: params.sessionKey,
    parentSessionKey: params.ctx.ParentSessionKey,
    threadParentId: normalizeText(params.ctx.ThreadParentId) || undefined,
  });
}

export function resolveAcpCommandBindingContext(params: HandleCommandsParams): {
  channel: string;
  accountId: string;
  threadId?: string;
  conversationId?: string;
  parentConversationId?: string;
} {
  const conversation = resolveAcpCommandCanonicalConversation(params);
  return {
    channel: resolveAcpCommandChannel(params),
    accountId: resolveAcpCommandAccountId(params),
    threadId: resolveAcpCommandThreadId(params),
    conversationId: resolveAcpCommandConversationId(params),
    ...(conversation.parentConversationId
      ? { parentConversationId: conversation.parentConversationId }
      : {}),
  };
}
