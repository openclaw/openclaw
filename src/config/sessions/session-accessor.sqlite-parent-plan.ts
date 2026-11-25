import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  extractToolCallsFromAssistant,
  isSyntheticMissingToolResult,
} from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { resolveParentForkSourceTranscript } from "./session-accessor.sqlite-parent-fork.js";
import {
  prepareTranscriptEventReadQuery,
  readTranscriptEventAtSeqInTransaction,
} from "./session-accessor.sqlite-read.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-state.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

// Enumerable symbols survive the resolver's shallow normalization copies, but
// never enter transcript JSON. IDs cannot carry provenance: duplicates are legal.
const sourceSeq = Symbol("parent-fork-source-seq");
type PlannedRecord = Record<string, unknown> & { [sourceSeq]?: number };

function pick(record: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]]),
  );
}

/** Retain navigation/classification/pairing facts, not historical bodies. */
function compact(event: TranscriptEvent): PlannedRecord | null {
  if (!isRecord(event)) {
    return null;
  }
  const entry = pick(event, [
    "type",
    "id",
    "parentId",
    "targetId",
    "appendParentId",
    "appendMode",
    "timestamp",
    "version",
    "cwd",
    "firstKeptEntryId",
    "reason",
    "tokensBefore",
    "thinkingLevel",
    "provider",
    "modelId",
    "fromId",
    "customType",
    "display",
    "label",
    "name",
    "excludeFromContext",
    "billsDisplaced",
  ]);
  const indexed = isIndexedSessionEntry(event);
  if (Object.hasOwn(event, "summary")) {
    entry.summary = typeof event.summary === "string" ? "" : event.summary;
  }
  if (Object.hasOwn(event, "content")) {
    entry.content = indexed ? [] : null;
  }
  if (isRecord(event.data)) {
    entry.data = pick(event.data, ["restart", "afterEntryId", "resultEntryIds"]);
  }
  if (isRecord(event.details)) {
    entry.details = pick(event.details, ["kind"]);
  }
  if (Object.hasOwn(event, "message")) {
    if (!isRecord(event.message)) {
      entry.message = null;
    } else {
      const message = pick(event.message, [
        "role",
        "provider",
        "model",
        "openclawModelPlacement",
        "excludeFromContext",
        "stopReason",
        "toolCallId",
        "toolUseId",
        "tool_call_id",
        "tool_use_id",
        "callId",
        "call_id",
        "toolName",
        "isError",
        "customType",
        "display",
        "command",
        "output",
      ]);
      // Only indexed messages enter reset pairing. Invalid messages still own
      // tree and last-completed semantics, but must never become indexed here.
      if (indexed && event.type === "message" && event.message.role === "assistant") {
        message.content = Array.isArray(event.message.content)
          ? extractToolCallsFromAssistant(event.message).map(({ id, name }) => ({
              type: "toolCall",
              id,
              name,
            }))
          : "";
      } else {
        message.content = indexed ? (Array.isArray(event.message.content) ? [] : "") : null;
      }
      if (typeof message.command === "string") {
        message.command = "";
      }
      if (typeof message.output === "string") {
        message.output = "";
      }
      message.details = {
        ...(isRecord(event.message.details) ? pick(event.message.details, ["kind"]) : {}),
        // Legacy ID inference can set isError later; retain the evidence now,
        // while keeping the original error flag for the pairing owner.
        openclawSyntheticMissingToolResult: isSyntheticMissingToolResult({
          ...event.message,
          isError: true,
        }),
      };
      entry.message = message;
    }
  }
  return entry;
}

/** The transaction owns this plan and all later point hydration. */
export function planSqliteParentForkSource(
  database: OpenClawAgentDatabase,
  sessionId: string,
  forkFrom?: "last-completed",
) {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () => {
    const entries: TranscriptEvent[] = [];
    for (const row of iterateSqliteQuerySync(
      database.db,
      prepareTranscriptEventReadQuery(database, sessionId)
        .select(["seq", transcriptEventJsonSql(database.db).as("event_json")])
        .orderBy("seq", "asc"),
    )) {
      const event = compact(JSON.parse(row.event_json));
      if (event) {
        event[sourceSeq] = row.seq;
      }
      entries.push(event);
    }
    return resolveParentForkSourceTranscript(entries, forkFrom);
  });
}

/** Generated headers/controls pass through; source rows receive only effective ancestry edits. */
export function hydrateSqliteParentForkEvent(
  database: OpenClawAgentDatabase,
  sessionId: string,
  planned: TranscriptEvent,
): TranscriptEvent {
  if (!isRecord(planned)) {
    return planned;
  }
  const { [sourceSeq]: seq }: PlannedRecord = planned;
  if (seq === undefined) {
    return planned;
  }
  const row = readTranscriptEventAtSeqInTransaction(database, sessionId, seq);
  if (!row || !isRecord(row.event)) {
    throw new Error("Parent fork source row disappeared inside its transaction");
  }
  const event = { ...row.event };
  if (Object.hasOwn(planned, "parentId")) {
    event.parentId = planned.parentId;
  }
  if (Object.hasOwn(planned, "firstKeptEntryId")) {
    event.firstKeptEntryId = planned.firstKeptEntryId;
  }
  return event;
}
