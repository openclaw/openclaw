/**
 * Runtime SDK subpath for thread binding lifecycle and session binding adapters.
 */
export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
export {
  resolveThreadBindingLifecycle,
  resolveThreadBindingExpiry,
  type ThreadBindingLifecycleRecord,
} from "../shared/thread-binding-lifecycle.js";
export {
  registerSessionBindingAdapter,
  registerSessionBindingAdapterV2,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingAdapterV2,
  type SessionBindingSelectionSnapshot,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export {
  createAccountScopedBindingAdapter,
  createAccountScopedBindingAdapterV2,
  projectThreadBindingRecord,
} from "../infra/outbound/session-binding-adapter.js";
export type { AccountScopedConversationBindingRecord } from "../infra/outbound/account-scoped-conversation-bindings.js";
