import { z } from "zod";

export const SESSION_MEMORY_CONFIDENCE_VALUES = ["high", "medium", "low"] as const;
export type SessionMemoryConfidence = (typeof SESSION_MEMORY_CONFIDENCE_VALUES)[number];

export const SESSION_MEMORY_CHILD_MODES = ["write", "recall", "signal"] as const;
export type SessionMemoryChildMode = (typeof SESSION_MEMORY_CHILD_MODES)[number];

export type SessionMemoryRawEntry = {
  messageId: string;
  timestamp: string;
  expiresAt: string;
  transcript: string;
  body?: string;
  bodyForAgent?: string;
  from?: string;
  to?: string;
  channelId?: string;
  conversationId?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  provider?: string;
  surface?: string;
  mediaPath?: string;
  mediaType?: string;
};

export type SessionMemorySummaryEntry = {
  messageId: string;
  timestamp: string;
  rawExpiresAt: string;
  decisions: string[];
  actionItems: string[];
  entities: string[];
  contextNote?: string;
  discard: boolean;
};

export type SessionMemoryAuditEvent =
  | "write"
  | "discard"
  | "write_failed"
  | "raw_expired";

export type SessionMemoryAuditEntry = {
  event: SessionMemoryAuditEvent;
  timestamp: string;
  messageId?: string;
  reason?: string;
};

export type SessionMemoryWriteResult = {
  mode: "write";
  decisions: string[];
  actionItems: string[];
  entities: string[];
  contextNote?: string;
  discard: boolean;
};

export type SessionMemoryRecallChildResult = {
  mode: "recall";
  result: string;
  source: "raw" | "summary";
  matchedSummaryIds: string[];
  usedRawMessageIds: string[];
};

export type SessionMemoryRecallResult = {
  mode: "recall";
  query: string;
  result: string;
  confidence: SessionMemoryConfidence;
  source: "raw" | "summary";
};

export type SessionMemorySignalResult = {
  mode: "signal";
  relevant: string[];
  discarded?: string;
};

const stringArraySchema = z.array(z.string());

export const sessionMemoryWriteResultSchema = z
  .object({
    mode: z.literal("write"),
    decisions: stringArraySchema,
    actionItems: stringArraySchema,
    entities: stringArraySchema,
    contextNote: z.string().optional(),
    discard: z.boolean(),
  })
  .strict();

export const sessionMemoryRecallChildResultSchema = z
  .object({
    mode: z.literal("recall"),
    result: z.string(),
    source: z.enum(["raw", "summary"]),
    matchedSummaryIds: stringArraySchema,
    usedRawMessageIds: stringArraySchema,
  })
  .strict();

export const sessionMemorySignalResultSchema = z
  .object({
    mode: z.literal("signal"),
    relevant: stringArraySchema,
    discarded: z.string().optional(),
  })
  .strict();

export const sessionMemoryRawEntrySchema = z
  .object({
    messageId: z.string(),
    timestamp: z.string(),
    expiresAt: z.string(),
    transcript: z.string(),
    body: z.string().optional(),
    bodyForAgent: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    channelId: z.string().optional(),
    conversationId: z.string().optional(),
    senderId: z.string().optional(),
    senderName: z.string().optional(),
    senderUsername: z.string().optional(),
    provider: z.string().optional(),
    surface: z.string().optional(),
    mediaPath: z.string().optional(),
    mediaType: z.string().optional(),
  })
  .strict();

export const sessionMemorySummaryEntrySchema = z
  .object({
    messageId: z.string(),
    timestamp: z.string(),
    rawExpiresAt: z.string(),
    decisions: stringArraySchema,
    actionItems: stringArraySchema,
    entities: stringArraySchema,
    contextNote: z.string().optional(),
    discard: z.boolean(),
  })
  .strict();

export const sessionMemoryAuditEntrySchema = z
  .object({
    event: z.enum(["write", "discard", "write_failed", "raw_expired"]),
    timestamp: z.string(),
    messageId: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
