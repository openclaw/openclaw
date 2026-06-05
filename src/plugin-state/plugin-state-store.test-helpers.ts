// Plugin state test helpers seed SQLite plugin state fixtures.
import { seedPluginStateDatabaseEntriesForTests } from "./plugin-state-store.sqlite.js";

// Test-only seed helpers for plugin state. Values are serialized through the
// same JSON storage path used by the production sqlite store.
export type PluginStateSeedEntry = {
  pluginId: string;
  namespace: string;
  key: string;
  value: unknown;
  createdAt?: number;
  expiresAt?: number | null;
};

/** Seeds plugin state entries for tests without opening public store handles. */
export function seedPluginStateEntriesForTests(entries: PluginStateSeedEntry[]): void {
  if (entries.length === 0) {
    return;
  }

  seedPluginStateDatabaseEntriesForTests(
    entries.map((entry) => {
      const valueJson = JSON.stringify(entry.value);
      if (valueJson == null) {
        throw new Error("plugin state seed value must be JSON serializable");
      }
      return {
        pluginId: entry.pluginId,
        namespace: entry.namespace,
        key: entry.key,
        valueJson,
        ...(entry.createdAt != null ? { createdAt: entry.createdAt } : {}),
        ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
      };
    }),
  );
}

// Latency event types and constants for Chat UI response latency display.
// These types structure the latency metrics passed via the `chat` WebSocket event.

/** Latency metrics for a chat response. */
export type ChatResponseLatency = {
  /** Time from send to first token in milliseconds. */
  firstOutputLatencyMs: number;
  /** Time from send to last token in milliseconds. */
  totalLatencyMs: number;
  /** Total number of tokens generated. */
  tokenCount?: number;
  /** Tokens generated per second. */
  tokensPerSecond?: number;
};

/** Event type for streaming latency updates. */
export type ChatLatencyEvent = {
  type: "chat-latency";
  messageId: string;
  latency: ChatResponseLatency;
  streaming: boolean;
};

/** Constants for latency event types. */
export const CHAT_LATENCY_EVENT_TYPE = "chat-latency" as const;

/** Helper to create a ChatLatencyEvent. */
export function createChatLatencyEvent(
  messageId: string,
  latency: ChatResponseLatency,
  streaming = false,
): ChatLatencyEvent {
  return {
    type: CHAT_LATENCY_EVENT_TYPE,
    messageId,
    latency,
    streaming,
  };
}
