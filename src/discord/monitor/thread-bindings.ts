export type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

export {
  formatThreadBindingTtlLabel,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
export {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";

export {
  resolveDiscordThreadBindingSessionTtlMs,
  resolveThreadBindingSessionTtlMs,
  resolveThreadBindingsEnabled,
} from "./thread-bindings.config.js";

export { isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.state.js";

export {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  listThreadBindingsForAccount,
  reconcileAcpThreadBindingsOnStartup,
  setThreadBindingTtlBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "./thread-bindings.lifecycle.js";

export type { AcpThreadBindingReconciliationResult } from "./thread-bindings.lifecycle.js";

export {
  __testing,
  createNoopThreadBindingManager,
  createThreadBindingManager,
  getThreadBindingManager,
} from "./thread-bindings.manager.js";
