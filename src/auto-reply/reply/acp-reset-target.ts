import {
  buildConfiguredAcpSessionKey,
  normalizeBindingConfig,
  type ConfiguredAcpBindingChannel,
} from "../../acp/persistent-bindings.types.js";
import { resolveConfiguredBindingRecord } from "../../channels/plugins/binding-registry.js";
import { listAcpBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { DEFAULT_ACCOUNT_ID, isAcpSessionKey } from "../../routing/session-key.js";

function normalizeText(value: string | undefined | null): string {
  return value?.trim() ?? "";
}

function resolveRawConfiguredAcpSessionKey(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string | undefined {
  for (const binding of listAcpBindings(params.cfg)) {
    const bindingChannel = normalizeText(binding.match.channel).toLowerCase();
    if (!bindingChannel || bindingChannel !== params.channel) {
      continue;
    }

    const bindingAccountId = normalizeText(binding.match.accountId);
    if (bindingAccountId && bindingAccountId !== "*" && bindingAccountId !== params.accountId) {
      continue;
    }

    const peerId = normalizeText(binding.match.peer?.id);
    const matchedConversationId =
      peerId === params.conversationId
        ? params.conversationId
        : peerId && peerId === params.parentConversationId
          ? params.parentConversationId
          : undefined;
    if (!matchedConversationId) {
      continue;
    }

    const acp = normalizeBindingConfig(binding.acp);
    return buildConfiguredAcpSessionKey({
      channel: params.channel as ConfiguredAcpBindingChannel,
      accountId: bindingAccountId && bindingAccountId !== "*" ? bindingAccountId : params.accountId,
      conversationId: matchedConversationId,
      ...(params.parentConversationId ? { parentConversationId: params.parentConversationId } : {}),
      agentId: binding.agentId,
      mode: acp.mode === "oneshot" ? "oneshot" : "persistent",
      ...(acp.cwd ? { cwd: acp.cwd } : {}),
      ...(acp.backend ? { backend: acp.backend } : {}),
      ...(acp.label ? { label: acp.label } : {}),
    });
  }

  return undefined;
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

  const rawConfiguredSessionKey = resolveRawConfiguredAcpSessionKey({
    cfg: params.cfg,
    channel,
    accountId,
    conversationId,
    ...(parentConversationId ? { parentConversationId } : {}),
  });
  if (rawConfiguredSessionKey) {
    return rawConfiguredSessionKey;
  }

  if (params.fallbackToActiveAcpWhenUnbound === false) {
    return undefined;
  }
  return activeAcpSessionKey;
}
