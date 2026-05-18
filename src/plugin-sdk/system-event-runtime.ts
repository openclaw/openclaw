// System event queue helpers without the broad infra-runtime barrel.

export {
  enqueueNotificationSystemEvent,
  resolveNotificationWakePolicy,
  type EnqueueNotificationSystemEventOptions,
  type EnqueueNotificationSystemEventResult,
} from "../infra/notification-system-events.js";

export {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
