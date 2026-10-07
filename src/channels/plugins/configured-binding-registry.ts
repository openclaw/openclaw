import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { parseConfiguredAcpSessionKey } from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import type {
  CompiledConfiguredBinding,
  ConfiguredBindingRecordResolution,
  ConfiguredBindingResolution,
} from "./binding-types.js";
import { resolveCompiledBindingRegistry } from "./configured-binding-compiler.js";
import type { ChannelConfiguredBindingMatch } from "./types.adapters.js";

function resolveAccountMatchPriority(match: string | undefined, actual: string): 0 | 1 | 2 {
  if (!match) {
    return actual === DEFAULT_ACCOUNT_ID ? 2 : 0;
  }
  if (match === "*") {
    return 1;
  }
  return normalizeAccountId(match) === actual ? 2 : 0;
}

/** Compile plugin binding rules before publishing a config or plugin generation. */
export function validateConfiguredBindings(cfg: OpenClawConfig): void {
  resolveCompiledBindingRegistry(cfg);
}

/**
 * Resolves a configured binding record from explicit channel/account/conversation ids.
 */
export function resolveConfiguredBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ConfiguredBindingRecordResolution | null {
  const resolved = resolveConfiguredBinding({
    cfg: params.cfg,
    conversation: {
      channel: params.channel,
      accountId: params.accountId,
      conversationId: params.conversationId,
      parentConversationId: params.parentConversationId,
    },
  });
  return resolved ? { record: resolved.record, statefulTarget: resolved.statefulTarget } : null;
}

/**
 * Resolves the full configured binding match, including compiled rule and match diagnostics.
 */
export function resolveConfiguredBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ConfiguredBindingResolution | null {
  const channel = normalizeOptionalLowercaseString(params.conversation.channel);
  const conversationId = params.conversation.conversationId.trim();
  if (!channel || !conversationId) {
    return null;
  }
  const conversation = {
    channel,
    accountId: normalizeAccountId(params.conversation.accountId),
    conversationId,
    parentConversationId: normalizeOptionalString(params.conversation.parentConversationId),
  };
  const rules = resolveCompiledBindingRegistry(params.cfg).get(channel);
  let bestMatch: { rule: CompiledConfiguredBinding; match: ChannelConfiguredBindingMatch } | null =
    null;
  let bestAccountPriority = 0;
  let bestMatchPriority = 0;
  for (const rule of rules ?? []) {
    const accountMatchPriority = resolveAccountMatchPriority(
      rule.accountPattern,
      conversation.accountId,
    );
    if (accountMatchPriority === 0) {
      continue;
    }
    const match = rule.provider.matchInboundConversation({
      binding: rule.binding,
      compiledBinding: rule.target,
      conversationId,
      parentConversationId: conversation.parentConversationId,
    });
    if (!match) {
      continue;
    }
    const matchPriority = match.matchPriority ?? 0;
    // Exact accounts outrank wildcards, then the channel's conversation priority decides.
    if (
      !bestMatch ||
      accountMatchPriority > bestAccountPriority ||
      (accountMatchPriority === bestAccountPriority && matchPriority > bestMatchPriority)
    ) {
      bestMatch = { rule, match };
      bestAccountPriority = accountMatchPriority;
      bestMatchPriority = matchPriority;
    }
  }
  if (!bestMatch) {
    return null;
  }
  return {
    conversation,
    compiledBinding: bestMatch.rule,
    match: bestMatch.match,
    ...bestMatch.rule.targetFactory.materialize({
      accountId: conversation.accountId,
      conversation: bestMatch.match,
    }),
  };
}

/**
 * Resolves a configured binding record by the stateful target session key.
 */
export function resolveConfiguredBindingRecordBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  const registry = resolveCompiledBindingRegistry(params.cfg);
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }
  const parsed = parseConfiguredAcpSessionKey(sessionKey);
  if (!parsed) {
    return null;
  }
  const rules = registry.get(parsed.channel);
  if (!rules) {
    return null;
  }
  let wildcardMatch: ConfiguredBindingRecordResolution | null = null;
  for (const rule of rules) {
    const accountMatchPriority = resolveAccountMatchPriority(rule.accountPattern, parsed.accountId);
    if (accountMatchPriority === 0) {
      continue;
    }
    // Wildcard rules derive their target session key from the parsed account.
    const materializedTarget = rule.targetFactory.materialize({
      accountId: parsed.accountId,
      conversation: rule.target,
    });
    if (materializedTarget.record.targetSessionKey === sessionKey) {
      if (accountMatchPriority === 2) {
        // Exact account matches outrank wildcard account bindings for the same session key.
        return materializedTarget;
      }
      wildcardMatch = materializedTarget;
    }
  }
  return wildcardMatch;
}
