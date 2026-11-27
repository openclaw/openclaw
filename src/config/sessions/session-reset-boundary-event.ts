import { randomUUID } from "node:crypto";
import type { SessionTreeEntry } from "@openclaw/agent-core";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import {
  isPendingBackgroundResultMessage,
  projectPlacedBackgroundResultMessage,
  readBackgroundResultPlacement,
} from "../../../packages/agent-core/src/harness/session/background-result-placement.js";
import {
  collectSessionContextEntryFact,
  iterateSessionContextEntryFacts,
  type SessionContextEntryFact,
} from "../../../packages/agent-core/src/harness/session/session.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { selectRecentUserAssistantReplayRecords } from "./transcript-replay.js";
import { selectSessionTranscriptLeafControlledPath } from "./transcript-tree.js";

type SessionResetBoundaryReason = "new" | "reset" | "idle" | "daily" | "cron-stale";

export type SessionResetBoundaryRequest =
  | { context: "clear"; reason: Extract<SessionResetBoundaryReason, "new" | "reset"> }
  | {
      context: "preserve-tail";
      reason: Extract<SessionResetBoundaryReason, "reset" | "idle" | "daily" | "cron-stale">;
    };

type SessionResetBoundaryEvent = {
  type: "reset";
  id: string;
  parentId: string | null;
  timestamp: string;
  reason: SessionResetBoundaryReason;
  firstKeptEntryId?: string;
};

function recordId(record: unknown): string | undefined {
  return readNonBlankString(asOptionalRecord(record)?.id);
}

function uniqueBoundaryId(records: readonly unknown[]): string {
  const ids = new Set(records.flatMap((record) => (recordId(record) ? [recordId(record)!] : [])));
  for (;;) {
    const id = randomUUID().slice(0, 8);
    if (!ids.has(id)) {
      return id;
    }
  }
}

export function createSessionResetBoundaryId(): string {
  return randomUUID();
}

/** Full entries, or reset navigation rows whose messages carry only their navigation fields. */
function isResetWindowEntry(entry: unknown): entry is SessionTreeEntry {
  return (
    isIndexedSessionEntry(entry) ||
    (isRecord(entry) &&
      entry.type === "message" &&
      recordId(entry) !== undefined &&
      isRecord(entry.message) &&
      typeof entry.message.role === "string")
  );
}

function projectLatestBoundaryWindow(entries: readonly unknown[]): unknown[] {
  if (
    entries.some(
      (entry) =>
        readBackgroundResultPlacement(entry) ||
        isPendingBackgroundResultMessage(asOptionalRecord(entry)?.message),
    )
  ) {
    // SQLite passes navigation rows without message bodies, so select the window from facts.
    const sources = new Map<SessionContextEntryFact, SessionTreeEntry>();
    const facts = entries.filter(isResetWindowEntry).map((entry) => {
      const fact = collectSessionContextEntryFact(entry);
      sources.set(fact, entry);
      return fact;
    });
    return Array.from(iterateSessionContextEntryFacts(facts), ({ entry: fact, placement }) => {
      const entry = sources.get(fact)!;
      return placement && entry.type === "message"
        ? {
            ...sources.get(placement),
            type: "message",
            message: projectPlacedBackgroundResultMessage(entry.message),
          }
        : entry;
    });
  }
  const boundaryIndex = entries.findLastIndex((entry) => {
    const type = asOptionalRecord(entry)?.type;
    return type === "compaction" || type === "reset";
  });
  if (boundaryIndex < 0) {
    return [...entries];
  }
  const boundary = entries[boundaryIndex] as {
    type?: unknown;
    firstKeptEntryId?: unknown;
  };
  const firstKeptIndex =
    typeof boundary.firstKeptEntryId === "string"
      ? entries.findIndex(
          (entry, index) => index < boundaryIndex && recordId(entry) === boundary.firstKeptEntryId,
        )
      : -1;
  const kept =
    firstKeptIndex < 0
      ? []
      : entries.slice(firstKeptIndex, boundaryIndex).filter((entry) => {
          const role = (entry as { message?: { role?: unknown } } | null)?.message?.role;
          return role === "user" || role === "assistant";
        });
  return [...kept, ...entries.slice(boundaryIndex + 1)];
}

export function buildSessionResetBoundaryEvent(
  params: {
    events: readonly unknown[];
    boundaryId?: string;
  } & SessionResetBoundaryRequest,
): SessionResetBoundaryEvent {
  const entries = params.events.filter((event) => isRecord(event) && event.type !== "session");
  const activeEntries = selectSessionTranscriptLeafControlledPath(entries) ?? entries;
  const keptEntries =
    params.context === "preserve-tail"
      ? selectRecentUserAssistantReplayRecords(projectLatestBoundaryWindow(activeEntries))
      : [];
  const firstKeptEntryId = recordId(keptEntries[0]);
  const boundaryId = params.boundaryId?.trim() || uniqueBoundaryId(params.events);
  if (params.events.some((event) => recordId(event) === boundaryId)) {
    throw new Error(`Reset boundary ID already exists: ${boundaryId}`);
  }
  return {
    type: "reset",
    id: boundaryId,
    parentId: recordId(activeEntries.at(-1)) ?? null,
    timestamp: new Date().toISOString(),
    reason: params.reason,
    ...(firstKeptEntryId ? { firstKeptEntryId } : {}),
  };
}
