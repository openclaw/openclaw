import { consumeSelectedSystemEventEntries, type SystemEvent } from "./system-events.js";

/** Consumes heartbeat-inspected events from the physical queues they came from. */
export function consumeHeartbeatSystemEventEntriesBySource(
  defaultSessionKey: string,
  consumedEntries: readonly SystemEvent[],
): SystemEvent[] {
  const entriesByQueue = new Map<string, SystemEvent[]>();
  for (const entry of consumedEntries) {
    const queueKey = entry.sourceQueueKey ?? defaultSessionKey;
    const queued = entriesByQueue.get(queueKey);
    if (queued) {
      queued.push(entry);
    } else {
      entriesByQueue.set(queueKey, [entry]);
    }
  }
  return [...entriesByQueue].flatMap(([queueKey, entries]) =>
    consumeSelectedSystemEventEntries(queueKey, entries),
  );
}
