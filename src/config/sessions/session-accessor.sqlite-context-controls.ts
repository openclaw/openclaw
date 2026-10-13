import { sql } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import {
  projectDetachedAssistantModelChangeSql,
  projectTranscriptPayloadNavigationSql,
} from "./session-model-context-projection.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import {
  transcriptEventModelNavigationSql,
  transcriptEventNavigationSql,
} from "./transcript-payload.js";

/** State controls survive compaction independently of the summarized message prefix. */
export function readRequiredContextWindow(
  projection: CurrentTranscriptProjection,
  boundaryPosition: number | undefined,
  keptPositions: readonly number[],
  beforeRawSeq?: number,
): {
  sequences: number[];
  eventCount: number;
  sizeBytes: number;
  assistantSequence?: number;
  assistantSizeBytes?: number;
} {
  if (boundaryPosition === undefined) {
    return { sequences: [], eventCount: 0, sizeBytes: 0 };
  }
  const db = getActiveTranscriptKysely(projection.database);
  const navigation = transcriptEventNavigationSql("event");
  const projectedNavigation =
    /* kysely-allow-raw: imports without native metadata still return only navigation facts. */
    sql<string>`CASE WHEN event.navigation_valid = 1 THEN ${projectTranscriptPayloadNavigationSql(navigation)} ELSE ${navigation} END`;
  const assistantModel = projectDetachedAssistantModelChangeSql(
    transcriptEventModelNavigationSql("event"),
  );
  const rows = iterateSqliteQuerySync(
    projection.database.db,
    db
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .select([
        "active.event_seq",
        "active.active_position",
        /* kysely-allow-raw: discarded assistant model state is admitted before acquisition. */
        sql<number | null>`CASE WHEN event.navigation_valid = 1
          AND event.navigation_last_type = 'message' AND event.message_role = 'assistant'
          THEN octet_length(${assistantModel}) + 1 ELSE NULL END`.as("assistant_bytes"),
        /* kysely-allow-raw: selected state uses the same byte fuse as bounded acquisition. */
        sql<number>`${transcriptEventReadBytesSql("event")} + 1`.as("read_bytes"),
        /* kysely-allow-raw: malformed/deep legacy navigation must not hydrate an unbounded body. */
        sql<string>`CASE WHEN octet_length(${projectedNavigation}) <= 65536
          THEN ${projectedNavigation}
          ELSE '{"type":"opaque-required"}' END`.as("navigation"),
      ])
      .where("active.session_id", "=", projection.resolved.sessionId)
      .$if(beforeRawSeq !== undefined, (query) =>
        query.where("active.event_seq", "<", beforeRawSeq!),
      )
      .orderBy("active.active_position", "desc"),
  );
  const selected: number[] = [];
  let sizeBytes = 0;
  let assistantSequence: number | undefined;
  let assistantSizeBytes: number | undefined;
  const kept = new Set(keptPositions);
  let modelDone = false;
  for (const row of rows) {
    // SAFETY: Only navigation tags/roles are read here; transcript readers validate payloads.
    const entry = JSON.parse(row.navigation) as {
      type?: string;
      customType?: string;
      message?: { role?: string };
    };
    let required = false;
    if (
      !modelDone &&
      (entry.type === "model_change" ||
        (entry.type === "message" && entry.message?.role === "assistant"))
    ) {
      modelDone = true;
      required = true;
    }
    if (
      entry.type === "opaque-required" ||
      entry.type === "thinking_level_change" ||
      entry.type === "model_change" ||
      (entry.type === "custom" && entry.customType !== "openclaw.cache-ttl") ||
      entry.type === "session_info"
    ) {
      required = true;
    }
    if (required && row.active_position < boundaryPosition && !kept.has(row.active_position)) {
      if (entry.type === "message" && entry.message?.role === "assistant") {
        assistantSequence = row.event_seq;
        assistantSizeBytes = row.assistant_bytes ?? undefined;
      }
      selected.push(row.event_seq);
      sizeBytes +=
        entry.type === "message" && entry.message?.role === "assistant"
          ? (row.assistant_bytes ?? row.read_bytes)
          : row.read_bytes;
    }
  }
  return {
    sequences: selected,
    eventCount: selected.length,
    sizeBytes,
    assistantSequence,
    assistantSizeBytes,
  };
}

/** Appends can supersede the model carrier without changing the retained boundary. */
export function refreshRequiredContextWindow(
  projection: CurrentTranscriptProjection,
  window: ResetMessageWindow,
): ResetMessageWindow {
  // Appends cannot change pre-boundary controls except for the inferred assistant
  // model carrier. Reuse static facts when there is no such carrier to supersede.
  if (window.requiredAssistantSequence === undefined) {
    return window;
  }
  const controls = readRequiredContextWindow(
    projection,
    window.boundaryActivePosition,
    window.keptActivePositions,
  );
  return {
    ...window,
    requiredControlSequences: controls.sequences,
    requiredAssistantSequence: controls.assistantSequence,
    requiredAssistantSizeBytes: controls.assistantSizeBytes,
    requiredControlSizeBytes: controls.sizeBytes,
    contextPrefixEventCount:
      window.contextPrefixEventCount - window.requiredControlSequences.length + controls.eventCount,
    contextPrefixSizeBytes:
      window.contextPrefixSizeBytes - window.requiredControlSizeBytes + controls.sizeBytes,
  };
}

export function selectRetainedContextRows<T extends { event: { type: string } }>(
  candidates: T[],
  scope: "context" | "history",
  boundaryType: string | null,
): T[] {
  return scope === "context" && boundaryType === "compaction"
    ? candidates.filter(
        ({ event }) =>
          event.type === "message" ||
          event.type === "custom_message" ||
          event.type === "branch_summary",
      )
    : candidates;
}

export type ResetMessageWindow = {
  boundarySeq: number;
  keptActivePositions: number[];
  requiredControlSequences: number[];
  requiredControlSizeBytes: number;
  requiredAssistantSequence?: number;
  requiredAssistantSizeBytes?: number;
  contextPrefixEventCount: number;
  keptMessagePositions: number[];
  contextPrefixSizeBytes: number;
  postBoundaryMessagePosition: number;
  boundaryActivePosition: number;
};
