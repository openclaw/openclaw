import {
  resolveConfiguredAcpBindingSpecFromRecord,
  toResolvedConfiguredAcpBinding,
  type ConfiguredAcpBindingSpec,
  type ResolvedConfiguredAcpBinding,
} from "../../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ConversationRef } from "../../infra/outbound/session-binding-service.js";
import {
  primeConfiguredBindingRegistry,
  resolveConfiguredBinding,
  resolveConfiguredBindingRecord,
  resolveConfiguredBindingRecordBySessionKey,
  resolveConfiguredBindingRecordForConversation,
} from "./binding-registry.js";
import type { ConfiguredBindingResolution } from "./binding-types.js";

function toResolvedConfiguredAcpBindingResolution(
  resolved: ConfiguredBindingResolution | null,
): (ConfiguredBindingResolution & { configuredBinding: ResolvedConfiguredAcpBinding }) | null {
  if (!resolved) {
    return null;
  }
  const configuredBinding = toResolvedConfiguredAcpBinding(resolved.record);
  if (!configuredBinding) {
    return null;
  }
  return {
    ...resolved,
    configuredBinding,
  };
}

export const primeConfiguredAcpBindingRegistry = primeConfiguredBindingRegistry;

export function resolveConfiguredAcpBindingRecord(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): ResolvedConfiguredAcpBinding | null {
  const resolved = resolveConfiguredBindingRecord(params);
  return resolved ? toResolvedConfiguredAcpBinding(resolved.record) : null;
}

export function resolveConfiguredAcpBindingRecordForConversation(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): ResolvedConfiguredAcpBinding | null {
  const resolved = resolveConfiguredBindingRecordForConversation(params);
  return resolved ? toResolvedConfiguredAcpBinding(resolved.record) : null;
}

export function resolveConfiguredAcpBinding(params: {
  cfg: OpenClawConfig;
  conversation: ConversationRef;
}): (ConfiguredBindingResolution & { configuredBinding: ResolvedConfiguredAcpBinding }) | null {
  return toResolvedConfiguredAcpBindingResolution(resolveConfiguredBinding(params));
}

export function resolveConfiguredAcpBindingSpecBySessionKey(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
}): ConfiguredAcpBindingSpec | null {
  const resolved = resolveConfiguredBindingRecordBySessionKey(params);
  return resolved ? resolveConfiguredAcpBindingSpecFromRecord(resolved.record) : null;
}
