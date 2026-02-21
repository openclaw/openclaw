export type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

export {
  formatThreadBindingTtlLabel,
  isRecentlyUnboundThreadWebhookMessage,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "./thread-bindings.state.js";

export {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  listThreadBindingsForAccount,
  setThreadBindingTtlBySessionKey,
  unbindThreadBindingsBySessionKey,
} from "./thread-bindings.lifecycle.js";

export {
  __testing,
  createNoopThreadBindingManager,
  createThreadBindingManager,
  getThreadBindingManager,
} from "./thread-bindings.manager.js";
