import { isMainThread } from "node:worker_threads";
import { sql } from "kysely";
import { isTranscriptArtifactProvider } from "../../../packages/agent-core/src/harness/session/transcript-model.js";
import {
  executeSqliteQueryTakeFirstSync,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { readCurrentProjectionSnapshot } from "./session-accessor.sqlite-projection-read.js";
import type { resolveSqliteTranscriptReadScope } from "./session-accessor.sqlite-read-scope.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { SessionTranscriptColdError } from "./session-cold-storage-state.js";
import type { ContextEntry } from "./session-model-context-window.js";
import {
  transcriptEventModelNavigationSql,
  transcriptEventModelBytesSql,
} from "./transcript-payload.js";

/** A semantic boundary can exclude old navigation without estimating a byte-pressure cut. */
export function readProjectedModelContextNavigation(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db" | "path">,
  resolved: ReturnType<typeof resolveSqliteTranscriptReadScope>,
  maxEvents: number,
  beforeRawSeq?: number,
) {
  if (isMainThread) {
    return undefined;
  }
  try {
    const result = readCurrentProjectionSnapshot(database, resolved, (projection) => {
      // Imported opaque identities need the canonical tree to normalize retained anchors.
      if (projection.hasUnindexedPrefix) {
        return undefined;
      }
      const db = getSessionKysely(database.db);
      const active = db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events", (join) =>
          join
            .onRef("transcript_events.session_id", "=", "active.session_id")
            .onRef("transcript_events.seq", "=", "active.event_seq"),
        )
        .innerJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
        .where("active.session_id", "=", resolved.sessionId)
        .$if(beforeRawSeq !== undefined, (query) =>
          query.where("active.event_seq", "<", beforeRawSeq!),
        );
      const navigation = active.select([
        "active.active_position",
        "transcript_events.seq",
        "identity.event_id",
        "identity.event_type",
        transcriptEventModelNavigationSql(database.db).as("navigation_json"),
        transcriptEventModelBytesSql(database.db, sql.lit(0)).as("model_bytes"),
        transcriptEventModelBytesSql(database.db, sql.lit(1)).as("retained_bytes"),
      ]);
      type Row = {
        active_position: number;
        seq: number;
        event_id: string;
        event_type: string | null;
        navigation_json: string;
        model_bytes: number;
        retained_bytes: number;
      };
      const parseEntry = (
        row: Pick<Row, "seq" | "event_id" | "event_type" | "navigation_json">,
      ) => {
        // SAFETY: The owned codec returns navigation; identities certify its canonical shape.
        const entry = JSON.parse(row.navigation_json) as ContextEntry;
        if (entry.id !== row.event_id || entry.type !== row.event_type) {
          return undefined;
        }
        entry.seq = row.seq;
        return entry;
      };
      const parse = (row: Row) => {
        const entry = parseEntry(row);
        return entry
          ? { entry, bytes: row.model_bytes, withoutCheckpointBytes: row.retained_bytes }
          : undefined;
      };
      const boundaryRow = executeSqliteQueryTakeFirstSync(
        database.db,
        navigation
          .where("identity.event_type", "in", ["compaction", "reset"])
          .orderBy("active.active_position", "desc")
          .limit(1),
      );
      // With no boundary the page owner already handles append reuse and exact prefix facts.
      if (!boundaryRow) {
        return undefined;
      }
      const boundary = parse(boundaryRow);
      if (!boundary || (boundary.entry.type !== "compaction" && boundary.entry.type !== "reset")) {
        return undefined;
      }
      let activeCount = projection.state.activeEventCount;
      if (beforeRawSeq !== undefined) {
        // Today's projected path need not be the leaf of the admitted prefix. Prove
        // their agreement before using current ancestry for a historical fence.
        let prefixLeaf: ContextEntry | undefined;
        let scanned = 0;
        for (const row of iterateSqliteQuerySync(
          database.db,
          db
            .selectFrom("transcript_event_identities as identity")
            .innerJoin("transcript_events", (join) =>
              join
                .onRef("transcript_events.session_id", "=", "identity.session_id")
                .onRef("transcript_events.seq", "=", "identity.seq"),
            )
            .select([
              "identity.seq",
              "identity.event_id",
              "identity.event_type",
              transcriptEventModelNavigationSql(database.db).as("navigation_json"),
            ])
            .where("identity.session_id", "=", resolved.sessionId)
            .where("identity.event_type", "in", [
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
            ])
            .where("identity.seq", "<", beforeRawSeq)
            .orderBy("identity.seq", "desc")
            .limit(129),
        )) {
          if (++scanned > 128) {
            return undefined;
          }
          const entry = parseEntry(row);
          if (!entry) {
            return undefined;
          }
          if (entry.appendMode !== "side") {
            prefixLeaf = entry;
            break;
          }
        }
        const control = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("transcript_event_identities")
            .select("seq")
            .where("session_id", "=", resolved.sessionId)
            .where("event_type", "=", "leaf")
            .where("seq", ">", prefixLeaf?.seq ?? -1)
            .where("seq", "<", beforeRawSeq)
            .limit(1),
        );
        const projectedLeaf = executeSqliteQueryTakeFirstSync(
          database.db,
          active
            .select(["identity.event_id", "active.event_seq", "active.active_position"])
            .orderBy("active.active_position", "desc")
            .limit(1),
        );
        if (
          control ||
          projectedLeaf?.event_id !== prefixLeaf?.id ||
          projectedLeaf?.event_seq !== prefixLeaf?.seq
        ) {
          return undefined;
        }
        activeCount = projectedLeaf ? projectedLeaf.active_position + 1 : 0;
      }
      let start = boundaryRow.active_position;
      if (boundary.entry.firstKeptEntryId !== undefined) {
        const kept = executeSqliteQueryTakeFirstSync(
          database.db,
          navigation
            .where("identity.event_id", "=", boundary.entry.firstKeptEntryId)
            .where("active.active_position", "<", start)
            .limit(1),
        );
        if (!kept) {
          if (boundary.entry.firstKeptEntryId !== boundary.entry.id) {
            return undefined;
          }
        } else {
          if (!parse(kept)) {
            return undefined;
          }
          start = kept.active_position;
        }
      }
      const eventLimit = Math.min(maxEvents, 10_000);
      if (activeCount - start > eventLimit) {
        return undefined;
      }
      const selected = [];
      for (const row of iterateSqliteQuerySync(
        database.db,
        navigation
          .where("active.active_position", ">=", start)
          .orderBy("active.active_position", "asc")
          .limit(eventLimit + 1),
      )) {
        if (selected.length === eventLimit) {
          return undefined;
        }
        const parsed = parse(row);
        if (!parsed) {
          return undefined;
        }
        selected.push({ ...parsed, position: row.active_position });
      }
      // The detached view preserves the last model and thinking state even before the cut.
      for (const type of ["thinking_level_change", "model_change"] as const) {
        let scanned = 0;
        for (const row of iterateSqliteQuerySync(
          database.db,
          navigation
            .where("identity.event_type", "=", type)
            .orderBy("active.active_position", "desc")
            .limit(129),
        )) {
          if (++scanned > 128) {
            return undefined;
          }
          const parsed = parse(row);
          if (!parsed) {
            return undefined;
          }
          // Keep both the raw latest state used by existing page receipts and the
          // inference state used by canonical cold projection; their policies differ.
          const inference =
            parsed.entry.type !== "model_change" ||
            !isTranscriptArtifactProvider(parsed.entry.provider);
          if (row.active_position < start && (scanned === 1 || inference)) {
            selected.push({ ...parsed, position: row.active_position });
          }
          if (inference) {
            break;
          }
        }
      }
      // A previous assistant can supply model identity; bound that search and otherwise fall back.
      const hasAssistantModel = selected.some(
        ({ entry }) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          !isTranscriptArtifactProvider(entry.message.provider),
      );
      if (!hasAssistantModel) {
        let scanned = 0;
        let assistantSeen = false;
        for (const row of iterateSqliteQuerySync(
          database.db,
          navigation
            .where("identity.event_type", "=", "message")
            .where("active.active_position", "<", start)
            .orderBy("active.active_position", "desc")
            .limit(129),
        )) {
          if (++scanned > 128) {
            return undefined;
          }
          const parsed = parse(row);
          if (!parsed) {
            return undefined;
          }
          if (parsed.entry.type === "message" && parsed.entry.message.role === "assistant") {
            const inference = !isTranscriptArtifactProvider(parsed.entry.message.provider);
            if (!assistantSeen || inference) {
              selected.push({ ...parsed, position: row.active_position });
            }
            assistantSeen = true;
            if (inference) {
              break;
            }
          }
        }
      }
      selected.sort((a, b) => a.position - b.position);
      // Active positions already encode canonical ancestry, including opaque-parent bypasses.
      for (const [index, row] of selected.entries()) {
        row.entry.parentId = selected[index - 1]?.entry.id ?? null;
      }
      return {
        rows: new Map(selected.map((row) => [row.entry.seq, row])),
        entries: selected.map(({ entry }) => entry),
      };
    });
    return result.kind === "value" ? result.value : undefined;
  } catch (error) {
    if (error instanceof SessionTranscriptColdError) {
      return undefined;
    }
    throw error;
  }
}
