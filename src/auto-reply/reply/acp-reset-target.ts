import { resolveConfiguredBindingRecord } from "../../channels/plugins/binding-registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { DEFAULT_ACCOUNT_ID, isAcpSessionKey } from "../../routing/session-key.js";

function normalizeText(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

export function resolveEffectiveResetTargetSessionKey(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  activeSessionKey?: string | null;
  allowNonAcpBindingSessionKey?: boolean;
  skipConfiguredFallbackWhenActiveSessionNonAcp?: boolean;
  fallbackToActiveAcpWhenUnbound?: boolean;
}): string | undefined {
  const activeSessionKey = normalizeText(params.activeSessionKey);
  const activeAcpSessionKey =
    activeSessionKey && isAcpSessionKey(activeSessionKey) ? activeSessionKey : undefined;
  const activeIsNonAcp = Boolean(activeSessionKey) && !activeAcpSessionKey;

  const channel = normalizeText(params.channel).toLowerCase();
  const conversationId = normalizeText(params.conversationId);
  if (!channel || !conversationId) {
    return activeAcpSessionKey;
  }
  const accountId = normalizeText(params.accountId) || DEFAULT_ACCOUNT_ID;
  const parentConversationId = normalizeText(params.parentConversationId) || undefined;
  const allowNonAcpBindingSessionKey = Boolean(params.allowNonAcpBindingSessionKey);

  const serviceBinding = getSessionBindingService().resolveByConversation({
    channel,
    accountId,
    conversationId,
    parentConversationId,
  });
  const serviceSessionKey =
    serviceBinding?.targetKind === "session" ? serviceBinding.targetSessionKey.trim() : "";
  if (serviceSessionKey) {
    if (allowNonAcpBindingSessionKey) {
      return serviceSessionKey;
    }
    return isAcpSessionKey(serviceSessionKey) ? serviceSessionKey : undefined;
  }

  if (activeIsNonAcp && params.skipConfiguredFallbackWhenActiveSessionNonAcp) {
    return undefined;
  }

  const configuredBinding = resolveConfiguredBindingRecord({
    cfg: params.cfg,
    channel,
    accountId,
    conversationId,
    parentConversationId,
  });
  const configuredSessionKey =
    configuredBinding?.record.targetKind === "session"
      ? configuredBinding.record.targetSessionKey.trim()
      : "";
  if (configuredSessionKey) {
    if (allowNonAcpBindingSessionKey) {
      return configuredSessionKey;
    }
    return isAcpSessionKey(configuredSessionKey) ? configuredSessionKey : undefined;
  }
  if (params.fallbackToActiveAcpWhenUnbound === false) {
    return undefined;
  }
  return activeAcpSessionKey;
}
