// Narrow thread-binding lifecycle helpers for extensions that need binding
// expiry and session-binding record types without loading the full
// conversation-runtime surface.

export {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../channels/thread-bindings-policy.js";
export type {
  BindingTargetKind,
  SessionBindingAdapter,
  SessionBindingAdapterV2,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export {
  createAccountScopedConversationBindingManager,
  createAccountScopedConversationBindingManagerV2,
  resetAccountScopedConversationBindingsForTests,
  type AccountScopedConversationBindingManager,
  type AccountScopedConversationBindingManagerV2,
  type AccountScopedConversationBindingRecord,
} from "../infra/outbound/account-scoped-conversation-bindings.js";
export {
  registerSessionBindingAdapter,
  registerSessionBindingAdapterV2,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
