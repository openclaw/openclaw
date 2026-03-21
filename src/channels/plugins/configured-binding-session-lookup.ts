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
