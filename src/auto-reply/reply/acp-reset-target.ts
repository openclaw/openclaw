import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  buildConfiguredAcpSessionKey,
  normalizeBindingConfig,
  type ConfiguredAcpBindingChannel,
} from "../../acp/persistent-bindings.types.js";
import { resolveConfiguredBindingRecord } from "../../channels/plugins/configured-binding-registry.js";
import { listAcpBindings } from "../../config/bindings.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { DEFAULT_ACCOUNT_ID, isAcpSessionKey } from "../../routing/session-key.js";

function resolveRawConfiguredAcpSessionKey(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): string | undefined {
  for (const binding of listAcpBindings(params.cfg)) {
    const bindingChannel = normalizeLowercaseStringOrEmpty(binding.match.channel);
    if (!bindingChannel || bindingChannel !== params.channel) {
      continue;
    }

    const bindingAccountId = normalizeOptionalString(binding.match.accountId) ?? "";
    if (bindingAccountId && bindingAccountId !== "*" && bindingAccountId !== params.accountId) {
      continue;
    }

    const peerId = normalizeOptionalString(binding.match.peer?.id) ?? "";
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

export async function resolveEffectiveResetTargetSessionKey(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  accountId?: string | null;
  conversationId?: string | null;
  parentConversationId?: string | null;
  commandTargetSessionKey?: string | null;
  activeSessionKey?: string | null;
  allowNonAcpBindingSessionKey?: boolean;
  skipConfiguredFallbackWhenActiveSessionNonAcp?: boolean;
  fallbackToActiveAcpWhenUnbound?: boolean;
}): Promise<string | undefined> {
  const allowedTarget = (sessionKey: string) =>
    params.allowNonAcpBindingSessionKey || isAcpSessionKey(sessionKey) ? sessionKey : undefined;
  const commandTargetSessionKey = normalizeOptionalString(params.commandTargetSessionKey);
  if (commandTargetSessionKey) {
    return allowedTarget(commandTargetSessionKey);
  }
  const activeSessionKey = normalizeOptionalString(params.activeSessionKey);
  const activeAcpSessionKey =
    activeSessionKey && isAcpSessionKey(activeSessionKey) ? activeSessionKey : undefined;
  const activeIsNonAcp = Boolean(activeSessionKey) && !activeAcpSessionKey;

  const channel = normalizeLowercaseStringOrEmpty(params.channel);
  const conversationId = normalizeOptionalString(params.conversationId) ?? "";
  if (!channel || !conversationId) {
    return activeAcpSessionKey;
  }
  const accountId =
    normalizeOptionalString(params.accountId) ??
    normalizeOptionalString(params.cfg.channels?.[channel]?.defaultAccount) ??
    DEFAULT_ACCOUNT_ID;
  const parentConversationId = normalizeOptionalString(params.parentConversationId);
  const conversation = { channel, accountId, conversationId, parentConversationId };
  const serviceBinding = await getSessionBindingService().resolveByConversationAsync(conversation);
  const serviceSessionKey =
    serviceBinding?.targetKind === "session" ? serviceBinding.targetSessionKey.trim() : "";
  if (serviceSessionKey) {
    return allowedTarget(serviceSessionKey);
  }

  if (activeIsNonAcp && params.skipConfiguredFallbackWhenActiveSessionNonAcp) {
    return undefined;
  }

  const configuredBinding = resolveConfiguredBindingRecord({
    cfg: params.cfg,
    ...conversation,
  });
  const configuredSessionKey =
    configuredBinding?.record.targetKind === "session"
      ? configuredBinding.record.targetSessionKey.trim()
      : "";
  if (configuredSessionKey) {
    return allowedTarget(configuredSessionKey);
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

  return params.fallbackToActiveAcpWhenUnbound === false ? undefined : activeAcpSessionKey;
}
