// Memory host event helpers append and read memory host event logs.
import fs from "node:fs/promises";
import path from "node:path";
import { appendRegularFile } from "../infra/fs-safe.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { MemoryDreamingPhaseName } from "./dreaming.js";

/** Legacy workspace-relative JSONL audit log for unscoped memory events. */
export const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");
const MEMORY_HOST_AGENT_EVENT_LOG_RELATIVE_DIR = path.join("memory", ".dreams", "agents");

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

/** Event emitted after a dreaming phase writes inline memory and/or reports. */
export type MemoryHostDreamCompletedEvent = {
  type: "memory.dream.completed";
  timestamp: string;
  phase: MemoryDreamingPhaseName;
  inlinePath?: string;
  reportPath?: string;
  lineCount: number;
  storageMode: "inline" | "separate" | "both";
};

/** Append-only memory host event schema stored as JSONL. */
export type MemoryHostEvent =
  | MemoryHostRecallRecordedEvent
  | MemoryHostPromotionAppliedEvent
  | MemoryHostDreamCompletedEvent;

/** Full event-log record schema, including opt-in diagnostic variants. */
export type MemoryHostEventRecord = MemoryHostEvent | MemoryHostRecallSkippedEvent;

/** Resolve an agent-scoped event journal, or the legacy unscoped journal when no agent is supplied. */
export function resolveMemoryHostEventLogPath(workspaceDir: string, agentId?: string): string {
  if (agentId?.trim()) {
    return path.join(
      workspaceDir,
      MEMORY_HOST_AGENT_EVENT_LOG_RELATIVE_DIR,
      normalizeAgentId(agentId),
      "events.jsonl",
    );
  }
  return path.join(workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
}

/** Append one memory host event, creating its journal directory with symlink-safe writes. */
export async function appendMemoryHostEvent(
  workspaceDir: string,
  event: MemoryHostEventRecord,
  agentId?: string,
): Promise<void> {
  const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir, agentId);
  await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
  await appendRegularFile({
    filePath: eventLogPath,
    content: `${JSON.stringify(event)}\n`,
    rejectSymlinkParents: true,
  });
}

function parseMemoryHostEventRecord(line: string): MemoryHostEventRecord | null {
  try {
    const record = JSON.parse(line) as MemoryHostEventRecord;
    if (
      record.type === "memory.recall.recorded" ||
      record.type === "memory.recall.skipped" ||
      record.type === "memory.promotion.applied" ||
      record.type === "memory.dream.completed"
    ) {
      return record;
    }
  } catch {
    // The log is best-effort diagnostics; one malformed line must not hide
    // later valid events or break memory status rendering.
  }
  return null;
}

async function readMemoryHostEventRecordsRaw(params: {
  workspaceDir: string;
  agentId?: string;
  limit?: number;
}): Promise<MemoryHostEventRecord[]> {
  const eventLogPath = resolveMemoryHostEventLogPath(params.workspaceDir, params.agentId);
  const raw = await fs.readFile(eventLogPath, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  if (!raw.trim()) {
    return [];
  }
  const events = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const record = parseMemoryHostEventRecord(line);
      return record ? [record] : [];
    });
  if (!Number.isFinite(params.limit)) {
    return events;
  }
  const limit = Math.max(0, Math.floor(params.limit as number));
  return limit === 0 ? [] : events.slice(-limit);
}

function applyMemoryHostEventLimit<T>(events: T[], limit: number | undefined): T[] {
  if (!Number.isFinite(limit)) {
    return events;
  }
  const normalizedLimit = Math.max(0, Math.floor(limit as number));
  return normalizedLimit === 0 ? [] : events.slice(-normalizedLimit);
}

/** Read recent memory host events, ignoring corrupt JSONL lines left by partial writes. */
export async function readMemoryHostEvents(params: {
  workspaceDir: string;
  agentId?: string;
  limit?: number;
}): Promise<MemoryHostEvent[]> {
  const events = await readMemoryHostEventRecordsRaw({
    workspaceDir: params.workspaceDir,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const legacyEvents = events.filter(
    (event): event is MemoryHostEvent => event.type !== "memory.recall.skipped",
  );
  return applyMemoryHostEventLimit(legacyEvents, params.limit);
}

/** Read recent memory host event records, including opt-in diagnostic variants. */
export async function readMemoryHostEventRecords(params: {
  workspaceDir: string;
  agentId?: string;
  limit?: number;
}): Promise<MemoryHostEventRecord[]> {
  return await readMemoryHostEventRecordsRaw(params);
}
