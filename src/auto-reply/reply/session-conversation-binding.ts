import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MsgContext } from "../templating.js";
import { resolveEffectiveResetTargetSessionKey } from "./acp-reset-target.js";
import { resolveConversationBindingContextFromMessage } from "./conversation-binding-input.js";
export function resolveSessionDefaultAccountId(params: {
  cfg: OpenClawConfig;
  channelRaw?: string;
  accountIdRaw?: string;
  persistedLastAccountId?: string;
}): string | undefined {
  const explicit = normalizeOptionalString(params.accountIdRaw);
  if (explicit) {
    return explicit;
  }
  const persisted = normalizeOptionalString(params.persistedLastAccountId);
  if (persisted) {
    return persisted;
  }
  const channel = normalizeOptionalLowercaseString(params.channelRaw);
  if (!channel) {
    return undefined;
  }
  // SAFETY: only the optional defaultAccount field is read; its unknown value is normalized below.
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefault = channels?.[channel]?.defaultAccount;
  return normalizeOptionalString(configuredDefault);
}

export function resolveSessionConversationBindingContext(
  cfg: OpenClawConfig,
  ctx: MsgContext,
): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
} | null {
  const bindingContext = resolveConversationBindingContextFromMessage({
    cfg,
    ctx,
  });
  if (!bindingContext) {
    return null;
  }
  return {
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  };
}

export function resolveBoundAcpSessionForCommandReset(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
  bindingContext?: {
    channel: string;
    accountId: string;
    conversationId: string;
    parentConversationId?: string;
  } | null;
}): string | undefined {
  const bindingContext =
    params.bindingContext ?? resolveSessionConversationBindingContext(params.cfg, params.ctx);
  return resolveEffectiveResetTargetSessionKey({
    cfg: params.cfg,
    channel: bindingContext?.channel,
    accountId: bindingContext?.accountId,
    conversationId: bindingContext?.conversationId,
    parentConversationId: bindingContext?.parentConversationId,
    activeSessionKey: normalizeOptionalString(params.ctx.SessionKey),
    allowNonAcpBindingSessionKey: false,
    skipConfiguredFallbackWhenActiveSessionNonAcp: true,
    fallbackToActiveAcpWhenUnbound: false,
  });
}
