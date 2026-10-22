// Narrow thread-binding lifecycle helpers for extensions that need binding
// expiry and session-binding record types without loading the full
// conversation-runtime surface.

/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { resolveThreadBindingConversationIdFromBindingId } from "../channels/thread-binding-id.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
/** @deprecated Retained for plugins built against OpenClaw 2026.10.4 and earlier; tracked by `plugin-sdk-private-runtime-shipped-exports`. */
export { resolveThreadBindingLifecycle } from "../shared/thread-binding-lifecycle.js";
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
