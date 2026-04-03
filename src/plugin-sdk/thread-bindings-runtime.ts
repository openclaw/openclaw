// Narrow thread-binding lifecycle helpers for extensions that need binding
// expiry and session-binding record types without loading the full
// conversation-runtime surface.

export { resolveThreadBindingFarewellText } from "../channels/thread-bindings-messages.js";
export { resolveThreadBindingLifecycle } from "../channels/thread-bindings-policy.js";
export type {
  BindingTargetKind,
  SessionBindingAdapter,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
export {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
} from "../infra/outbound/session-binding-service.js";
