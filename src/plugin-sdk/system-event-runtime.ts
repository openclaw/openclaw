// Narrow system event enqueue/peek helper surface without the broad infra-runtime barrel.

export {
  enqueueRoutedSystemEvent,
  enqueueSystemEventFromSdk as enqueueSystemEvent,
  peekSystemEventEntriesFromSdk as peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../plugins/runtime/system-events.js";
export { resolveMainSessionKeyFromConfig } from "../config/sessions/main-session.runtime.js";
