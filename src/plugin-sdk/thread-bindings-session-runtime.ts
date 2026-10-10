/**
 * Runtime SDK subpath for thread binding lifecycle and session binding adapters.
 */
export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export {
  resolveThreadBindingLifecycle,
  resolveThreadBindingExpiry,
  type ThreadBindingLifecycleRecord,
} from "../shared/thread-binding-lifecycle.js";
export {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export {
  createAccountScopedBindingAdapter,
  projectThreadBindingRecord,
} from "../infra/outbound/session-binding-adapter.js";
export type { AccountScopedConversationBindingRecord } from "../infra/outbound/account-scoped-conversation-bindings.js";
