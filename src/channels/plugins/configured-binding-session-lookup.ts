import type { ConfiguredBindingRecordResolution } from "./binding-types.js";
import type { CompiledConfiguredBindingRegistry } from "./configured-binding-compiler.js";
import { listConfiguredBindingConsumers } from "./configured-binding-consumers.js";
import {
  materializeConfiguredBindingRecord,
  resolveAccountMatchPriority,
  resolveCompiledBindingChannel,
} from "./configured-binding-match.js";

export function resolveConfiguredBindingRecordBySessionKeyFromRegistry(params: {
  registry: CompiledConfiguredBindingRegistry;
  sessionKey: string;
}): ConfiguredBindingRecordResolution | null {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) {
    return null;
  }

  for (const consumer of listConfiguredBindingConsumers()) {
    const parsed = consumer.parseSessionKey?.({ sessionKey });
    if (!parsed) {
      continue;
    }
    const channel = resolveCompiledBindingChannel(parsed.channel);
    if (!channel) {
      continue;
    }
    const rules = params.registry.rulesByChannel.get(channel);
    if (!rules || rules.length === 0) {
      continue;
    }
    let wildcardMatch: ConfiguredBindingRecordResolution | null = null;
    let exactMatch: ConfiguredBindingRecordResolution | null = null;
    for (const rule of rules) {
      if (rule.targetFactory.driverId !== consumer.id) {
        continue;
      }
      const accountMatchPriority = resolveAccountMatchPriority(
        rule.accountPattern,
        parsed.accountId,
      );
      if (accountMatchPriority === 0) {
        continue;
      }
      // NOTE: rule.target holds the compile-time conversation ref from config (e.g. the parent
      // channel ID). Per-thread session keys embed a runtime thread ID that is never stored in
      // compiled bindings, so this lookup will always return null for thread-derived sessions.
      // Callers that need per-thread resolution should go through resolveConfiguredBindingRecord
      // with the live conversationId/parentConversationId pair instead.
      const materializedTarget = materializeConfiguredBindingRecord({
        rule,
        accountId: parsed.accountId,
        conversation: rule.target,
      });
      const matchesSessionKey =
        consumer.matchesSessionKey?.({
          sessionKey,
          compiledBinding: rule,
          accountId: parsed.accountId,
          materializedTarget,
        }) ?? materializedTarget.record.targetSessionKey === sessionKey;
      if (matchesSessionKey) {
        if (accountMatchPriority === 2) {
          exactMatch = materializedTarget;
          break;
        }
        wildcardMatch = materializedTarget;
      }
    }
    if (exactMatch) {
      return exactMatch;
    }
    if (wildcardMatch) {
      return wildcardMatch;
    }
  }

  return null;
}
