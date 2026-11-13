import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type {
  FileEntry,
  SessionEntry,
  SessionHeader,
  SessionMessageEntry,
} from "../../agents/sessions/session-manager-types.js";
import { MIN_READABLE_SESSION_VERSION } from "./version.js";

const sessionEntryTypes = new Set([
  "message",
  "thinking_level_change",
  "model_change",
  "compaction",
  "reset",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
const resetReasonSchema = z.coerce
  .string()
  .pipe(z.enum(["new", "reset", "idle", "daily", "cron-stale"]));
const parentLinkedOpaqueEntrySchema = z.object({
  type: z
    .unknown()
    .optional()
    .refine((type) => type !== "session" && type !== "leaf"),
  id: z.string().min(1),
  parentId: z.union([z.string(), z.null()]),
});
const opaqueLeafEntrySchema = z.object({
  type: z.literal("leaf"),
  id: z.string().min(1),
  parentId: z.union([z.string(), z.null()]),
  targetId: z.union([z.string(), z.null()]),
  appendParentId: z.union([z.string(), z.null()]).optional(),
  appendMode: z.literal("side").optional(),
});
const sessionHeaderSchema = z.object({ type: z.literal("session"), id: z.string() });

/** Legacy writers could repeat the same header with a different timestamp. */
export function equivalentLegacySessionHeaders(
  first: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  return isDeepStrictEqual({ ...first, timestamp: undefined }, { ...next, timestamp: undefined });
}

export function findSessionTranscriptHeader(entries: Iterable<unknown>): SessionHeader | undefined {
  for (const entry of entries) {
    if (sessionHeaderSchema.safeParse(entry).success) {
      // SAFETY: The shared header schema preserves the existing readable header contract.
      return entry as SessionHeader;
    }
  }
  return undefined;
}

export function assertCurrentSessionTranscriptHeader(header: SessionHeader | undefined): void {
  if ((header?.version ?? 1) < MIN_READABLE_SESSION_VERSION) {
    throw new Error(
      "Persisted legacy session transcripts require doctor/import migration before runtime use",
    );
  }
}

export function isReadableSessionMessage(
  message: unknown,
): message is Extract<
  SessionMessageEntry["message"],
  { role: "user" | "assistant" | "toolResult" | "custom" | "bashExecution" }
> {
  if (!isRecord(message)) {
    return false;
  }
  switch (message.role) {
    case "user":
    case "assistant":
      return isReadableContent(message.content);
    case "custom":
      return typeof message.customType === "string" && isReadableContent(message.content);
    case "toolResult":
      return (
        typeof message.toolCallId === "string" &&
        typeof message.toolName === "string" &&
        typeof message.isError === "boolean" &&
        Array.isArray(message.content)
      );
    case "bashExecution":
      return typeof message.command === "string" && typeof message.output === "string";
    default:
      return false;
  }
}

export function isIndexedSessionEntry(entry: unknown): entry is SessionEntry {
  // Stored/imported rows can be opaque even under a current header. Classify without parsed copies.
  if (
    !isRecord(entry) ||
    !isNonemptyString(entry.id) ||
    (entry.parentId !== undefined &&
      entry.parentId !== null &&
      typeof entry.parentId !== "string") ||
    (entry.timestamp !== undefined && typeof entry.timestamp !== "string")
  ) {
    return false;
  }
  switch (entry.type) {
    case "message":
      return isReadableSessionMessage(entry.message);
    case "thinking_level_change":
      return isNonemptyString(entry.thinkingLevel);
    case "model_change":
      return isNonemptyString(entry.provider) && isNonemptyString(entry.modelId);
    case "compaction":
      return (
        typeof entry.summary === "string" &&
        isNonemptyString(entry.firstKeptEntryId) &&
        typeof entry.tokensBefore === "number"
      );
    case "reset":
      return (
        (entry.firstKeptEntryId === undefined || typeof entry.firstKeptEntryId === "string") &&
        resetReasonSchema.safeParse(entry.reason).success
      );
    case "branch_summary":
      return typeof entry.fromId === "string" && typeof entry.summary === "string";
    case "custom":
      return isNonemptyString(entry.customType);
    case "custom_message":
      return (
        isNonemptyString(entry.customType) &&
        isReadableContent(entry.content) &&
        typeof entry.display === "boolean"
      );
    case "label":
      return (
        isNonemptyString(entry.targetId) &&
        (entry.label === undefined || typeof entry.label === "string")
      );
    case "session_info":
      return entry.name === undefined || typeof entry.name === "string";
    default:
      return false;
  }
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isReadableContent(value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }
  if (!Array.isArray(value)) {
    return false;
  }
  for (const block of value) {
    if (!isRecord(block) || typeof block.type !== "string") {
      return false;
    }
  }
  return true;
}

function isReadableLegacySessionEntry(value: unknown): value is FileEntry {
  const message = isRecord(value) && value.type === "message" ? value.message : undefined;
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    sessionEntryTypes.has(value.type) &&
    (value.type !== "message" ||
      (isRecord(message) && message.role === "hookMessage"
        ? isReadableContent(message.content)
        : isReadableSessionMessage(message)))
  );
}

function normalizePersistedLegacyHookMessage(value: unknown): unknown {
  if (!isRecord(value) || value.type !== "message" || !isRecord(value.message)) {
    return value;
  }
  const message = value.message;
  if (
    message.role !== "custom" ||
    message.customType !== undefined ||
    !isReadableContent(message.content)
  ) {
    return value;
  }
  return { ...value, message: { ...message, customType: "hook" } };
}

export function parseParentLinkedOpaqueEntry(
  record: unknown,
): { id: string; parentId: string | null } | undefined {
  const parsed = parentLinkedOpaqueEntrySchema.safeParse(record);
  return parsed.success ? { id: parsed.data.id, parentId: parsed.data.parentId } : undefined;
}

export function parseOpaqueLeafEntry(record: unknown):
  | {
      id: string;
      parentId: string | null;
      targetId: string | null;
      appendParentId?: string | null;
      appendMode?: "side";
    }
  | undefined {
  const parsed = opaqueLeafEntrySchema.safeParse(record);
  if (!parsed.success) {
    return undefined;
  }
  const leaf = parsed.data;
  return {
    id: leaf.id,
    parentId: leaf.parentId,
    targetId: leaf.targetId,
    ...(leaf.appendParentId !== undefined ? { appendParentId: leaf.appendParentId } : {}),
    ...(leaf.appendMode === "side" ? { appendMode: leaf.appendMode } : {}),
  };
}

export function classifySessionFileEntry(rawEntry: unknown, sourceVersion: number) {
  const entry = normalizePersistedLegacyHookMessage(rawEntry);
  // Legacy rows can lack modern IDs; avoid constructing a discarded validation error for each one.
  if (
    (sourceVersion < MIN_READABLE_SESSION_VERSION && isReadableLegacySessionEntry(entry)) ||
    isIndexedSessionEntry(entry)
  ) {
    return { entry, recognized: true as const };
  }
  return { entry, recognized: false as const };
}

export function partitionSessionFileEntries(entries: readonly unknown[]): {
  fileEntries: FileEntry[];
  opaqueEntries: Array<{ index: number; record: unknown }>;
  fileEntriesByOriginalIndex: Array<FileEntry | undefined>;
} {
  const fileEntries: FileEntry[] = [];
  const opaqueEntries: Array<{ index: number; record: unknown }> = [];
  const fileEntriesByOriginalIndex: Array<FileEntry | undefined> = [];
  const header = findSessionTranscriptHeader(entries);
  const sourceVersion = header?.version ?? 1;
  let hasHeader = false;
  for (const [originalIndex, rawEntry] of entries.entries()) {
    if (!hasHeader && header !== undefined && rawEntry === header) {
      fileEntries.push(header);
      fileEntriesByOriginalIndex[originalIndex] = header;
      hasHeader = true;
      continue;
    }
    const { entry, recognized } = classifySessionFileEntry(rawEntry, sourceVersion);
    if (recognized) {
      fileEntries.push(entry);
      fileEntriesByOriginalIndex[originalIndex] = entry;
      continue;
    }
    opaqueEntries.push({ index: fileEntries.length, record: entry });
  }
  return { fileEntries, opaqueEntries, fileEntriesByOriginalIndex };
}
