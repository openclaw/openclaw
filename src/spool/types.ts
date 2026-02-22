/**
 * Spool event types for event-driven dispatch.
 *
 * Spool is an event-based trigger mechanism that complements cron (time-based).
 * Events are JSON files placed in ~/.openclaw/spool/events/ and processed automatically
 * by the gateway's file watcher.
 *
 * Core types (SpoolPriority, SpoolAgentTurnPayload, SpoolPayload, SpoolEvent, SpoolEventCreate)
 * are derived from Zod schemas in schema.ts to maintain a single source of truth.
 */

import type { z } from "zod";
import type {
  spoolPrioritySchema,
  spoolPayloadSchema,
  spoolEventSchema,
  spoolEventCreateSchema,
} from "./schema.js";

// Derived from Zod schemas - single source of truth
export type SpoolPriority = z.infer<typeof spoolPrioritySchema>;
export type SpoolPayload = z.infer<typeof spoolPayloadSchema>;
export type SpoolAgentTurnPayload = SpoolPayload; // Alias for clarity
export type SpoolEvent = z.infer<typeof spoolEventSchema>;
export type SpoolEventCreate = z.infer<typeof spoolEventCreateSchema>;

// These types are NOT in Zod - keep as manual definitions
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
