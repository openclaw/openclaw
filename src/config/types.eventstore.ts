/**
 * Event Store Configuration Types
 *
 * Event Store provides persistent event streaming via NATS JetStream.
 * It works alongside (not instead of) memory backends like QMD.
 *
 * Key capabilities:
 * - Full audit trail of all agent interactions
 * - Temporal queries ("what happened on Feb 2?")
 * - Multi-agent event isolation
 * - Training data extraction
 * - Real-time event streaming (WebSocket bridge)
 */

export type EventStoreConfig = {
  /** Enable event store integration (default: false). */
  enabled?: boolean;

  /** NATS server URL. Supports auth: nats://user:pass@host:port */
  natsUrl?: string;

  /** JetStream stream name (default: "openclaw-events"). */
  streamName?: string;

  /** Subject prefix for events (default: "openclaw.events"). */
  subjectPrefix?: string;

  /** Stream retention settings. */
  retention?: EventStoreRetentionConfig;
};

export type EventStoreRetentionConfig = {
  /** Maximum number of messages to retain (default: unlimited). */
  maxMessages?: number;

  /** Maximum bytes to retain (default: unlimited). */
  maxBytes?: number;

  /** Maximum age of messages in hours (default: unlimited). */
  maxAgeHours?: number;
};

/** Event types emitted to the store. */
export type EventType =
  | "conversation.message_in"
  | "conversation.message_out"
  | "conversation.tool_call"
  | "conversation.tool_result"
  | "lifecycle.session_start"
  | "lifecycle.session_end"
  | "lifecycle.compaction"
  | "lifecycle.error"
  | "knowledge.fact"
  | "knowledge.decision";

/** Event visibility levels. */
export type EventVisibility = "public" | "internal" | "confidential";
