// Memory host event helpers append and read persisted memory host events.
import path from "node:path";
import type { MemoryDreamingPhaseName } from "./dreaming.js";
import { listStoredMemoryHostEvents, registerMemoryHostEvent } from "./event-store.js";

/** Event emitted when a recall query records the selected memory snippets. */
export type MemoryHostRecallRecordedEvent = {
  type: "memory.recall.recorded";
  timestamp: string;
  query: string;
  resultCount: number;
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
};

/** Event emitted when recall hits are visible but excluded from short-term promotion. */
export type MemoryHostRecallSkippedEvent = {
  type: "memory.recall.skipped";
  timestamp: string;
  query: string;
  reason: "non-short-term-memory-path";
  eligibleResultCount: number;
  skippedResultCount: number;
  results: Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    reason: "non-short-term-memory-path";
  }>;
};

/** Event emitted when deep-dream candidates are promoted into durable memory. */
export type MemoryHostPromotionAppliedEvent = {
  type: "memory.promotion.applied";
  timestamp: string;
  memoryPath: string;
  applied: number;
  candidates: Array<{
    key: string;
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    recallCount: number;
  }>;
};

/** Normalized outcome for a dreaming phase run. */
export type MemoryDreamOutcome = "completed" | "failed";

/** Event emitted after a dreaming phase writes inline memory and/or reports. */
export type MemoryHostDreamCompletedEvent = {
  type: "memory.dream.completed";
  timestamp: string;
  phase: MemoryDreamingPhaseName;
  /** Missing on older event logs; readers should treat absent as "completed". */
  outcome?: MemoryDreamOutcome;
  /** Error detail when outcome is "failed". */
  error?: string;
  inlinePath?: string;
  reportPath?: string;
  lineCount: number;
  storageMode: "inline" | "separate" | "both";
};

/** Durable memory host events consumed by status and public-artifact readers. */
export type MemoryHostEvent =
  | MemoryHostRecallRecordedEvent
  | MemoryHostPromotionAppliedEvent
  | MemoryHostDreamCompletedEvent;

/** Full event record schema, including opt-in diagnostic variants. */
export type MemoryHostEventRecord = MemoryHostEvent | MemoryHostRecallSkippedEvent;

/** Legacy workspace JSONL path retained only for doctor migration discovery. */
export const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");

/** Resolve the retired JSONL source path without reading it at runtime. */
export function resolveMemoryHostEventLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
}

/** Append one memory host event to shared SQLite plugin state. */
export async function appendMemoryHostEvent(
  workspaceDir: string,
  event: MemoryHostEventRecord,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  registerMemoryHostEvent({
    workspaceDir,
    event,
    ...(options.env ? { env: options.env } : {}),
  });
}

async function readMemoryHostEventRecordsRaw(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEventRecord[]> {
  const events = listStoredMemoryHostEvents(params).map((entry) => entry.value.event);
  return applyMemoryHostEventLimit(events, params.limit);
}

function applyMemoryHostEventLimit<T>(events: T[], limit: number | undefined): T[] {
  if (!Number.isFinite(limit)) {
    return events;
  }
  const normalizedLimit = Math.max(0, Math.floor(limit as number));
  return normalizedLimit === 0 ? [] : events.slice(-normalizedLimit);
}

/** Read recent memory host events, excluding opt-in diagnostic variants. */
export async function readMemoryHostEvents(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEvent[]> {
  const events = await readMemoryHostEventRecordsRaw({
    workspaceDir: params.workspaceDir,
    ...(params.env ? { env: params.env } : {}),
  });
  const legacyEvents = events.filter(
    (event): event is MemoryHostEvent => event.type !== "memory.recall.skipped",
  );
  return applyMemoryHostEventLimit(legacyEvents, params.limit);
}

/** Read recent memory host event records, including opt-in diagnostic variants. */
export async function readMemoryHostEventRecords(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEventRecord[]> {
  return await readMemoryHostEventRecordsRaw(params);
}
