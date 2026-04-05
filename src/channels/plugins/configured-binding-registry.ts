import type { MullusiConfig } from "../../config/config.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import type {
  ConfiguredBindingRecordResolution,
  ConfiguredBindingResolution,
} from "./binding-types.js";
import {
  countCompiledBindingRegistry,
  primeCompiledBindingRegistry,
  resolveCompiledBindingRegistry,
} from "./configured-binding-compiler.js";
import {
  materializeConfiguredBindingRecord,
  resolveMatchingConfiguredBinding,
  toConfiguredBindingConversationRef,
} from "./configured-binding-match.js";
import { resolveConfiguredBindingRecordBySessionKeyFromRegistry } from "./configured-binding-session-lookup.js";

function resolveMaterializedConfiguredBinding(params: {
  cfg: MullusiConfig;
  conversation: ConversationRef;
}) {
  const conversation = toConfiguredBindingConversationRef(params.conversation);
  if (!conversation) {
    return null;
  }
  const rules = resolveCompiledBindingRegistry(params.cfg).rulesByChannel.get(conversation.channel);
  if (!rules || rules.length === 0) {
    return null;
  }
  const resolved = resolveMatchingConfiguredBinding({
    rules,
    conversation,
  });
  if (!resolved) {
    return null;
  }
  return {
    conversation,
    resolved,
    materializedTarget: materializeConfiguredBindingRecord({
      rule: resolved.rule,
      accountId: conversation.accountId,
      conversation: resolved.match,
    }),
  };
}

export function primeConfiguredBindingRegistry(params: { cfg: MullusiConfig }): {
  bindingCount: number;
  channelCount: number;
} {
  return countCompiledBindingRegistry(primeCompiledBindingRegistry(params.cfg));
}

export function resolveConfiguredBindingRecord(params: {
  cfg: MullusiConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null {
  const conversation = toConfiguredBindingConversationRef({
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!conversation) {
    return null;
  }
  return resolveConfiguredBindingRecordForConversation({
    cfg: params.cfg,
    conversation,
  });
}

export function resolveConfiguredBindingRecordForConversation(params: {
  cfg: MullusiConfig;
  conversation: ConversationRef;
}): ConfiguredBindingRecordResolution | null {
  const resolved = resolveMaterializedConfiguredBinding(params);
  if (!resolved) {
    return null;
  }
  return resolved.materializedTarget;
}

export function resolveConfiguredBinding(params: {
  cfg: MullusiConfig;
  conversation: ConversationRef;
}): ConfiguredBindingResolution | null {
  const resolved = resolveMaterializedConfiguredBinding(params);
  if (!resolved) {
    return null;
  }
  return {
    conversation: resolved.conversation,
    compiledBinding: resolved.resolved.rule,
    match: resolved.resolved.match,
    ...resolved.materializedTarget,
  };
}

export function resolveConfiguredBindingRecordBySessionKey(params: {
  cfg: MullusiConfig;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  return resolveConfiguredBindingRecordBySessionKeyFromRegistry({
    registry: resolveCompiledBindingRegistry(params.cfg),
    sessionKey: params.sessionKey,
  });
}
