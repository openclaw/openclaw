// Public binding helpers for both runtime plugin-owned bindings and
// config-driven channel bindings.

import { ensureConfiguredAcpBindingSession } from "../acp/persistent-bindings.lifecycle.js";
import { resolveConfiguredAcpBindingRecord } from "../acp/persistent-bindings.resolve.js";
import type {
  ConfiguredAcpBindingChannel,
  ResolvedConfiguredAcpBinding,
} from "../acp/persistent-bindings.types.js";
import type { OpenClawConfig } from "../config/config.js";
import type { ResolvedAgentRoute } from "../routing/resolve-route.js";
import { deriveLastRoutePolicy } from "../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";

export {
  createConversationBindingRecord,
  getConversationBindingCapabilities,
  listSessionBindingRecords,
  resolveConversationBindingRecord,
  touchConversationBindingRecord,
  unbindConversationBindingRecord,
} from "../bindings/records.js";
export {
  ensureConfiguredBindingRouteReady,
  resolveConfiguredBindingRoute,
  type ConfiguredBindingRouteResult,
} from "../channels/plugins/binding-routing.js";
export {
  primeConfiguredBindingRegistry,
  resolveConfiguredBinding,
  resolveConfiguredBindingRecord,
  resolveConfiguredBindingRecordBySessionKey,
  resolveConfiguredBindingRecordForConversation,
} from "../channels/plugins/binding-registry.js";
export {
  ensureConfiguredBindingTargetReady,
  ensureConfiguredBindingTargetSession,
  resetConfiguredBindingTargetInPlace,
} from "../channels/plugins/binding-targets.js";
export type {
  ConfiguredBindingConversation,
  ConfiguredBindingResolution,
  CompiledConfiguredBinding,
  StatefulBindingTargetDescriptor,
} from "../channels/plugins/binding-types.js";
export type {
  StatefulBindingTargetDriver,
  StatefulBindingTargetReadyResult,
  StatefulBindingTargetResetResult,
  StatefulBindingTargetSessionResult,
} from "../channels/plugins/stateful-target-drivers.js";
export {
  type BindingStatus,
  type BindingTargetKind,
  type ConversationRef,
  SessionBindingError,
  type SessionBindingAdapter,
  type SessionBindingAdapterCapabilities,
  type SessionBindingBindInput,
  type SessionBindingCapabilities,
  type SessionBindingPlacement,
  type SessionBindingRecord,
  type SessionBindingService,
  type SessionBindingUnbindInput,
  getSessionBindingService,
  isSessionBindingError,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
export * from "../pairing/pairing-challenge.js";
export * from "../pairing/pairing-messages.js";
export * from "../pairing/pairing-store.js";
export {
  buildPluginBindingApprovalCustomId,
  buildPluginBindingDeclinedText,
  buildPluginBindingErrorText,
  buildPluginBindingResolvedText,
  buildPluginBindingUnavailableText,
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  hasShownPluginBindingFallbackNotice,
  isPluginOwnedBindingMetadata,
  isPluginOwnedSessionBindingRecord,
  markPluginBindingFallbackNoticeShown,
  parsePluginBindingApprovalCustomId,
  requestPluginConversationBinding,
  resolvePluginConversationBindingApproval,
  toPluginConversationBinding,
} from "../plugins/conversation-binding.js";

/** @deprecated Use `resolveConfiguredBindingRoute` instead. */
export function resolveConfiguredAcpRoute(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  channel: ConfiguredAcpBindingChannel;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
}): {
  configuredBinding: ResolvedConfiguredAcpBinding | null;
  route: ResolvedAgentRoute;
  boundSessionKey?: string;
  boundAgentId?: string;
} {
  const configuredBinding = resolveConfiguredAcpBindingRecord({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    conversationId: params.conversationId,
    parentConversationId: params.parentConversationId,
  });
  if (!configuredBinding) {
    return {
      configuredBinding: null,
      route: params.route,
    };
  }

  const boundSessionKey = configuredBinding.record.targetSessionKey?.trim() ?? "";
  if (!boundSessionKey) {
    return {
      configuredBinding,
      route: params.route,
    };
  }

  const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
  return {
    configuredBinding,
    boundSessionKey,
    boundAgentId,
    route: {
      ...params.route,
      sessionKey: boundSessionKey,
      agentId: boundAgentId,
      lastRoutePolicy: deriveLastRoutePolicy({
        sessionKey: boundSessionKey,
        mainSessionKey: params.route.mainSessionKey,
      }),
      matchedBy: "binding.channel",
    },
  };
}

/** @deprecated Use `ensureConfiguredBindingRouteReady` instead. */
export async function ensureConfiguredAcpRouteReady(params: {
  cfg: OpenClawConfig;
  configuredBinding: ResolvedConfiguredAcpBinding | null;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!params.configuredBinding) {
    return { ok: true };
  }
  const ensured = await ensureConfiguredAcpBindingSession({
    cfg: params.cfg,
    spec: params.configuredBinding.spec,
  });
  if (ensured.ok) {
    return { ok: true };
  }
  return {
    ok: false,
    error: ensured.error ?? "unknown error",
  };
}
