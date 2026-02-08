/**
 * Spool event types for event-driven dispatch.
 *
 * Spool is an event-based trigger mechanism that complements cron (time-based).
 * Events are JSON files placed in ~/.openclaw/spool/events/ and processed automatically
 * by the gateway's file watcher.
 */

export type SpoolPriority = "low" | "normal" | "high" | "critical";

export type SpoolAgentTurnPayload = {
  kind: "agentTurn";
  /** The message to send to the agent. */
  message: string;
  /** Optional: specific agent ID. */
  agentId?: string;
  /** Optional: session key override. */
  sessionKey?: string;
  /** Optional: model override (provider/model or alias). */
  model?: string;
  /** Optional: thinking level (off|minimal|low|medium|high|xhigh). */
  thinking?: string;
  /** Optional: delivery settings for sending the agent's response. */
  delivery?: {
    enabled?: boolean;
    channel?: string;
    to?: string;
  };
};

export type SpoolPayload = SpoolAgentTurnPayload;

export type SpoolEvent = {
  version: 1;
  /** Unique event ID (UUID). */
  id: string;
  /** ISO 8601 timestamp of when the event was created. */
  createdAt: string;
  /** Unix timestamp in milliseconds of when the event was created. */
  createdAtMs: number;
  /** Event priority (affects processing order). */
  priority?: SpoolPriority;
  /** Maximum number of retry attempts (default: 3). */
  maxRetries?: number;
  /** Current retry count (incremented on each failure). */
  retryCount?: number;
  /** ISO 8601 timestamp after which the event should be discarded. */
  expiresAt?: string;
  /** The event payload. */
  payload: SpoolPayload;
};

export type SpoolEventCreate = Omit<SpoolEvent, "id" | "createdAt" | "createdAtMs" | "retryCount">;

export type SpoolDispatchResult = {
  status: "ok" | "error" | "skipped" | "expired";
  eventId: string;
  error?: string;
  summary?: string;
};

export type SpoolWatcherState = {
  running: boolean;
  eventsDir: string;
  deadLetterDir: string;
  pendingCount: number;
};
