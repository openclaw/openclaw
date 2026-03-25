// Narrow thread-binding lifecycle helpers for extensions that need binding
// expiry and session-binding record types without loading the full
// conversation-runtime surface.

export { resolveThreadBindingLifecycle } from "../channels/thread-bindings-policy.js";
export type {
  BindingTargetKind,
  SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
