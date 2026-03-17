import { EventEmitter } from "node:events";
import fs from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("oag/event-bus");

export type OagEventType =
  | "channel_state_changed"
  | "session_watch_update"
  | "task_watch_update"
  | "user_note_pending"
  | "health_snapshot_updated"
  | "incident_recorded"
  | "evolution_applied"
  | "evolution_reverted"
  | "evolution_confirmed"
  | "diagnosis_completed"
  | "metrics_snapshot";

type OagEventPayload = {
  type: OagEventType;
  timestamp: number;
  data?: unknown;
};

type OagEventHandler = (event: OagEventPayload) => void;

const bus = new EventEmitter();
bus.setMaxListeners(50);

let fileWatcher: fs.FSWatcher | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 50;

export function emitOagEvent(type: OagEventType, data?: unknown): void {
  const event: OagEventPayload = {
    type,
    timestamp: Date.now(),
    data,
  };
  bus.emit("oag", event);
}

export function onOagEvent(handler: OagEventHandler): () => void {
  bus.on("oag", handler);
  return () => bus.off("oag", handler);
}

export function onceOagEvent(type: OagEventType, handler: OagEventHandler): () => void {
  const wrapped = (event: OagEventPayload) => {
    if (event.type === type) {
      bus.off("oag", wrapped);
      handler(event);
    }
  };
  bus.on("oag", wrapped);
  return () => bus.off("oag", wrapped);
}

export function getOagEventListenerCount(): number {
  return bus.listenerCount("oag");
}

let cachedSnapshot: Record<string, unknown> | null = null;

export function getCachedHealthSnapshot(): Record<string, unknown> | null {
  if (cachedSnapshot === null) {
    return null;
  }
  // Return a deep clone to prevent external mutation of the cached snapshot.
  return JSON.parse(JSON.stringify(cachedSnapshot)) as Record<string, unknown>;
}

export function startFileWatcher(
  filePath: string,
  onUpdate: (content: string) => void,
): () => void {
  if (fileWatcher) {
    return () => {};
  }

  try {
    fileWatcher = fs.watch(filePath, { persistent: false }, (eventType) => {
      if (eventType !== "change") {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        try {
          const content = fs.readFileSync(filePath, "utf8");
          cachedSnapshot = JSON.parse(content) as Record<string, unknown>;
          onUpdate(content);
          emitOagEvent("health_snapshot_updated", cachedSnapshot);
        } catch (err) {
          log.warn(`Failed to read OAG state file: ${String(err)}`);
        }
      }, DEBOUNCE_MS);
    });

    // Initial read
    try {
      const content = fs.readFileSync(filePath, "utf8");
      cachedSnapshot = JSON.parse(content) as Record<string, unknown>;
    } catch {
      // File may not exist yet
    }

    log.info(`Watching OAG state file: ${filePath}`);
    return () => stopFileWatcher();
  } catch (err) {
    log.warn(`Failed to start file watcher: ${String(err)}`);
    return () => {};
  }
}

export function stopFileWatcher(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

export function resetOagEventBus(): void {
  bus.removeAllListeners("oag");
  stopFileWatcher();
  cachedSnapshot = null;
}
