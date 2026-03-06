// Slack thread bindings reuse the same record shape as Discord.
// threadId = Slack thread_ts, channelId = Slack channel ID.
// No webhook fields needed — Slack uses bot token via chat.postMessage.
export type {
  ThreadBindingRecord,
  ThreadBindingTargetKind,
  ThreadBindingManager,
  PersistedThreadBindingRecord,
  PersistedThreadBindingsPayload,
} from "../../discord/monitor/thread-bindings.types.js";

export {
  THREAD_BINDINGS_VERSION,
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  DEFAULT_FAREWELL_TEXT,
} from "../../discord/monitor/thread-bindings.types.js";
