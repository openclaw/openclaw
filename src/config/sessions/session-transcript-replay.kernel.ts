import { RUNTIME_CONTEXT_CUSTOM_TYPE } from "@openclaw/llm-core";
import { sql } from "kysely";
import { projectSessionEntryMessage } from "../../../packages/agent-core/src/harness/session/session.js";
import { SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE } from "../../../packages/agent-core/src/operator-messages.js";
import { jsonPathValue } from "../../infra/database-engine/json-values.js";
import { executeSqliteQueryTakeFirstSync } from "../../infra/kysely-sync.js";
import { withCurrentProjectionSnapshot } from "./session-accessor.sqlite-active-projection.js";
import { getActiveTranscriptKysely } from "./session-accessor.sqlite-projection-read.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptReadScope } from "./session-accessor.types.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import { transcriptEventReadBytesSql } from "./session-transcript-read-bytes.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence-error.js";
import { resolveSqliteSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import {
  validateSessionTranscriptReplaySelection,
  type SessionTranscriptReplayGroup,
  type SessionTranscriptReplaySelection,
} from "./session-transcript-replay.types.js";
import { readTranscriptPayload, transcriptEventNavigationSql } from "./transcript-payload.js";

/** Read requested active users and their contiguous owned carriers in one admitted snapshot. */
export function readSessionTranscriptReplayGroupsCore(
  scope: SessionTranscriptReadScope,
  selection: SessionTranscriptReplaySelection,
  options: { resolvedScope?: ResolvedTranscriptReadScope } = {},
): SessionTranscriptReplayGroup[] {
  const maxBytes = validateSessionTranscriptReplaySelection(selection);
  return withCurrentProjectionSnapshot(
    scope,
    (projection) => {
      const { database, resolved } = projection;
      const db = getActiveTranscriptKysely(database);
      const fence = resolveSqliteSessionTranscriptReadFence({ database, ...resolved });
      if (fence && projection.generation !== fence.admission.generation) {
        throw new SessionTranscriptReadFenceError(
          "Current-turn transcript admission generation changed",
        );
      }
      let bytes = 0;
      const groups: SessionTranscriptReplayGroup[] = [];
      // Metadata and payload reads share this snapshot; no decompression precedes the budget check.
      const rows = db
        .selectFrom("session_transcript_active_events as active")
        .innerJoin("transcript_events as event", (join) =>
          join
            .onRef("event.session_id", "=", "active.session_id")
            .onRef("event.seq", "=", "active.event_seq"),
        )
        .where("active.session_id", "=", resolved.sessionId)
        .where("active.event_seq", "<", fence?.beforeRawSeq ?? Number.MAX_SAFE_INTEGER);
      const navigation = transcriptEventNavigationSql(database.db, "event");
      const metadata = rows.select([
        "active.active_position",
        "active.event_seq",
        transcriptEventReadBytesSql("event").as("bytes"),
        jsonPathValue(database.db, navigation, sql.lit("$.type")).as("type"),
        jsonPathValue(database.db, navigation, sql.lit("$.message.role")).as("role"),
        jsonPathValue(database.db, navigation, sql.lit("$.customType")).as("customType"),
      ]);
      const hydrate = (row: { event_seq: number; bytes: number }) => {
        bytes += row.bytes + 1;
        if (bytes > maxBytes) {
          throw new RangeError(`Session transcript replay exceeds maxBytes (${maxBytes})`);
        }
        const payload = executeSqliteQueryTakeFirstSync(
          database.db,
          rows
            .select(["event.event_json", "event.event_zstd", "event.event_utf8_bytes"])
            .where("active.event_seq", "=", row.event_seq),
        );
        if (!payload) {
          throw new Error("Selected replay entry disappeared inside its snapshot");
        }
        const entry: unknown = JSON.parse(readTranscriptPayload(payload));
        if (!isIndexedSessionEntry(entry)) {
          throw new Error("Selected replay entry is not a readable session entry");
        }
        return projectSessionEntryMessage(entry);
      };
      for (const entryId of new Set(selection.entryIds)) {
        const user = executeSqliteQueryTakeFirstSync(
          database.db,
          metadata
            .innerJoin("transcript_event_identities as identity", (join) =>
              join
                .onRef("identity.session_id", "=", "active.session_id")
                .onRef("identity.seq", "=", "active.event_seq"),
            )
            .where("identity.event_id", "=", entryId)
            .where("identity.session_id", "=", resolved.sessionId),
        );
        if (!user || user.type !== "message" || user.role !== "user") {
          continue;
        }
        const message = hydrate(user);
        if (!message) {
          continue;
        }
        const group: SessionTranscriptReplayGroup = { entryId, message, carriers: [] };
        // Seek by active position, not raw sequence: abandoned branches cannot supply carriers.
        for (let position = user.active_position + 1; ; position += 1) {
          const next = executeSqliteQueryTakeFirstSync(
            database.db,
            metadata.where("active.active_position", "=", position),
          );
          if (
            !next ||
            next.type !== "custom_message" ||
            (next.customType !== RUNTIME_CONTEXT_CUSTOM_TYPE &&
              next.customType !== SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE)
          ) {
            break;
          }
          const carrier = hydrate(next);
          if (carrier) {
            group.carriers.push(carrier);
          }
        }
        groups.push(group);
      }
      return groups;
    },
    { ...options, readOnly: true },
  );
}
