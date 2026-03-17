// Public pairing/session-binding helpers for plugins that manage conversation ownership.

export * from "../acp/persistent-bindings.route.js";
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
