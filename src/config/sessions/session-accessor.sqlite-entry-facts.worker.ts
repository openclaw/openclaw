import { toUSVString } from "node:util";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { readStringValue } from "@openclaw/normalization-core/string-coerce";
import { expressionBuilder } from "kysely";
import { executeSqliteQuerySync, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { parseReadableSessionEntryData } from "./session-accessor.sqlite-entry-read.js";
import {
  readParticipantRecord,
  withProjectedParticipants,
  type SessionParticipantRecord,
} from "./session-accessor.sqlite-participant-projection.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import { canonicalSessionValidationQuery } from "./session-canonical-key.js";
import {
  sessionEntrySnapshotColumnsForKeys,
  type SessionEntryProjection,
} from "./session-entry-snapshots.js";
import type { SessionMember } from "./session-membership-facts.types.js";
import { MAX_SESSION_ROW_FACTS_KEYS } from "./session-transcript-worker.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

// The aggregate crosses JSON instead of node:sqlite's integer conversion boundary.
function readInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new RangeError("Session fact integer cannot be represented safely");
  }
  return value;
}

function readRows(value: string): unknown[][] {
  const rows: unknown = JSON.parse(value);
  if (!Array.isArray(rows) || !rows.every(Array.isArray)) {
    throw new Error("Invalid stored session fact rows");
  }
  return rows;
}

/** One statement snapshot owns the entry, participant aggregates and membership records. */
export function readExactSessionEntryFactsInDatabase(
  database: Pick<OpenClawAgentDatabase, "agentId" | "db">,
  sessionKeys: readonly string[],
  projection: SessionEntryProjection = "full",
): {
  entries: SessionEntrySummary[];
  members: Record<string, SessionMember[]>;
  participantRecords: Record<string, SessionParticipantRecord[]>;
} {
  if (sessionKeys.length > MAX_SESSION_ROW_FACTS_KEYS) {
    throw new Error(`Session entry facts support at most ${MAX_SESSION_ROW_FACTS_KEYS} keys`);
  }
  const lookupKeys = [...new Set(sessionKeys.flatMap(collectSessionEntryLookupKeys))];
  const eb = expressionBuilder<DB, "session_nodes">();
  const participants = eb
    .selectFrom("session_participants")
    .select((builder) =>
      builder.fn
        .agg<string>("json_group_array", [
          builder.fn("json_array", [
            builder.ref("identity_namespace"),
            builder.ref("actor_id"),
            builder.ref("contribution_count"),
            builder.ref("first_prompted_at"),
            builder.ref("last_prompted_at"),
          ]),
        ])
        .orderBy("first_prompted_at")
        .orderBy("actor_id")
        .orderBy("identity_namespace")
        .as("records"),
    )
    .whereRef("session_participants.session_key", "=", "session_nodes.session_key")
    .$asScalar();
  const membership = eb
    .selectFrom("session_members")
    .select((builder) =>
      builder.fn
        .agg<string>("json_group_array", [
          builder.fn("json_array", [
            builder.ref("identity_id"),
            builder.ref("added_by"),
            builder.ref("added_at"),
          ]),
        ])
        .orderBy("identity_id")
        .as("records"),
    )
    .whereRef("session_members.session_key", "=", "session_nodes.session_key")
    .$asScalar();
  const rows = executeSqliteQuerySync(
    database.db,
    canonicalSessionValidationQuery(database, { metadata: true })
      .select("session_nodes.updated_at")
      .select(sessionEntrySnapshotColumnsForKeys(undefined, projection))
      .select([participants.as("participant_records_json"), membership.as("members_json")])
      .where("session_nodes.session_key", "in", sqliteStringSet(lookupKeys)),
  ).rows;
  // Folded aliases guard the logical read even when only the requested spelling is returned.
  const byKey = new Map(
    rows.map((row) => [
      row.session_key,
      {
        row,
        entry: parseReadableSessionEntryData(database, row, projection),
      },
    ]),
  );
  const entries: SessionEntrySummary[] = [];
  const members: Record<string, SessionMember[]> = {};
  const participantRecords: Record<string, SessionParticipantRecord[]> = {};
  for (const sessionKey of sessionKeys) {
    const selected = byKey.get(toUSVString(sessionKey));
    if (!selected?.entry) {
      continue;
    }
    const { row, entry } = selected;
    const records = readRows(row.participant_records_json).map((participant) =>
      readParticipantRecord({
        identity_namespace: expectDefined(
          readStringValue(participant[0]),
          "session participant identity namespace",
        ),
        actor_id: expectDefined(readStringValue(participant[1]), "session participant actor ID"),
        contribution_count: readInteger(participant[2]),
        first_prompted_at: participant[3] === null ? null : readInteger(participant[3]),
        last_prompted_at: participant[4] === null ? null : readInteger(participant[4]),
      }),
    );
    entries.push({ sessionKey, entry: withProjectedParticipants(entry, records) });
    members[sessionKey] = readRows(row.members_json).map((member) => ({
      identityId: expectDefined(readStringValue(member[0]), "session member identity ID"),
      addedBy: expectDefined(readStringValue(member[1]), "session member added-by identity"),
      addedAt: readInteger(member[2]),
    }));
    if (records.length) {
      participantRecords[sessionKey] = records;
    }
  }
  return { entries, members, participantRecords };
}
