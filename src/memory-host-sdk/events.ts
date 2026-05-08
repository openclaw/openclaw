import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPluginStateKeyedStore } from "../plugin-state/plugin-state-store.js";
import { MEMORY_CORE_PLUGIN_ID } from "./dreaming-state-store.js";
import type { MemoryDreamingPhaseName } from "./dreaming.js";

export const MEMORY_HOST_EVENT_LOG_RELATIVE_PATH = path.join("memory", ".dreams", "events.jsonl");
const MEMORY_HOST_EVENTS_NAMESPACE = "memory-host.events";
const MAX_MEMORY_HOST_EVENTS = 50_000;
const WORKSPACE_HASH_BYTES = 24;

type StoredMemoryHostEvent = {
  workspaceKey: string;
  event: MemoryHostEvent;
  recordedAt: number;
};

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

export type MemoryHostDreamCompletedEvent = {
  type: "memory.dream.completed";
  timestamp: string;
  phase: MemoryDreamingPhaseName;
  inlinePath?: string;
  reportPath?: string;
  lineCount: number;
  storageMode: "inline" | "separate" | "both";
};

export type MemoryHostEvent =
  | MemoryHostRecallRecordedEvent
  | MemoryHostPromotionAppliedEvent
  | MemoryHostDreamCompletedEvent;

let eventSequence = 0;

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function hashValue(value: string, bytes = 32): string {
  return createHash("sha256").update(value).digest("hex").slice(0, bytes);
}

function workspacePrefix(workspaceDir: string): { prefix: string; workspaceKey: string } {
  const workspaceKey = normalizeWorkspaceKey(workspaceDir);
  return {
    prefix: hashValue(workspaceKey, WORKSPACE_HASH_BYTES),
    workspaceKey,
  };
}

function getMemoryHostEventStore(env?: NodeJS.ProcessEnv) {
  return createPluginStateKeyedStore<StoredMemoryHostEvent>(MEMORY_CORE_PLUGIN_ID, {
    namespace: MEMORY_HOST_EVENTS_NAMESPACE,
    maxEntries: MAX_MEMORY_HOST_EVENTS,
    ...(env ? { env } : {}),
  });
}

function nextEventKey(workspaceDir: string, recordedAt: number): string {
  const { prefix } = workspacePrefix(workspaceDir);
  eventSequence = (eventSequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}:${recordedAt.toString(36)}:${process.pid.toString(36)}:${eventSequence.toString(36)}:${randomUUID()}`;
}

function legacyEventKey(workspaceDir: string, line: string, lineNumber: number): string {
  const { prefix } = workspacePrefix(workspaceDir);
  const digest = hashValue(`${lineNumber}\0${line}`);
  return `${prefix}:legacy:${digest}`;
}

function eventTimestampMs(event: MemoryHostEvent): number | undefined {
  const parsed = Date.parse(event.timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveMemoryHostEventLogPath(workspaceDir: string): string {
  return path.join(workspaceDir, MEMORY_HOST_EVENT_LOG_RELATIVE_PATH);
}

export async function appendMemoryHostEvent(
  workspaceDir: string,
  event: MemoryHostEvent,
): Promise<void> {
  const recordedAt = Date.now();
  const { workspaceKey } = workspacePrefix(workspaceDir);
  await getMemoryHostEventStore().register(nextEventKey(workspaceDir, recordedAt), {
    workspaceKey,
    event,
    recordedAt,
  });
}

export async function readMemoryHostEvents(params: {
  workspaceDir: string;
  limit?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<MemoryHostEvent[]> {
  const { prefix, workspaceKey } = workspacePrefix(params.workspaceDir);
  const events = (await getMemoryHostEventStore(params.env).entries())
    .filter(
      (entry) => entry.key.startsWith(`${prefix}:`) && entry.value.workspaceKey === workspaceKey,
    )
    .toSorted((left, right) => {
      const leftTime = eventTimestampMs(left.value.event) ?? left.value.recordedAt;
      const rightTime = eventTimestampMs(right.value.event) ?? right.value.recordedAt;
      if (leftTime !== rightTime) {
        return leftTime - rightTime;
      }
      if (left.value.recordedAt !== right.value.recordedAt) {
        return left.value.recordedAt - right.value.recordedAt;
      }
      return left.key.localeCompare(right.key);
    })
    .map((entry) => entry.value.event);
  if (!Number.isFinite(params.limit)) {
    return events;
  }
  const limit = Math.max(0, Math.floor(params.limit as number));
  return limit === 0 ? [] : events.slice(-limit);
}

export function renderMemoryHostEventsJsonl(events: readonly MemoryHostEvent[]): string {
  return events.length === 0 ? "" : `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
}

export async function importLegacyMemoryHostEventLogToSqlite(params: {
  workspaceDir: string;
  eventLogPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ imported: number; warnings: string[] }> {
  const eventLogPath = params.eventLogPath ?? resolveMemoryHostEventLogPath(params.workspaceDir);
  const raw = await fs.readFile(eventLogPath, "utf8").catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "";
    }
    throw err;
  });
  if (!raw.trim()) {
    await fs.rm(eventLogPath, { force: true });
    return { imported: 0, warnings: [] };
  }

  const { workspaceKey } = workspacePrefix(params.workspaceDir);
  const store = getMemoryHostEventStore(params.env);
  const warnings: string[] = [];
  let imported = 0;
  const lines = raw.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as MemoryHostEvent;
      const inserted = await store.registerIfAbsent(
        legacyEventKey(params.workspaceDir, trimmed, index + 1),
        {
          workspaceKey,
          event,
          recordedAt: eventTimestampMs(event) ?? Date.now(),
        },
      );
      if (inserted) {
        imported += 1;
      }
    } catch {
      warnings.push(`Skipped invalid memory host event at ${eventLogPath}:${index + 1}`);
    }
  }

  if (warnings.length === 0) {
    await fs.rm(eventLogPath, { force: true });
  }
  return { imported, warnings };
}
