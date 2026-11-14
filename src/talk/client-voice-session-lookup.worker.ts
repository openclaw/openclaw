import { expressionBuilder, sql } from "kysely";
import { jsonPathValue, jsonValid } from "../infra/database-engine/json-values.js";
import { iterateSqliteQuerySync } from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db-contract.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB } from "../state/openclaw-agent-db.generated.js";
import {
  parseStoredVoiceSessionRecord,
  voiceSessionRowsQuery,
  type VoiceSessionLookup,
  type VoiceSessionMatch,
} from "./client-voice-session-store.js";

function voiceSessionField(
  db: EngineConnection,
  field: "status" | "agentId" | "sessionKey" | "origin" | "voiceSessionId",
) {
  // The sole writer uses JSON.stringify, so stored fields have unique object keys.
  // Literal JSON paths preserve the canonical partial-index expressions.
  const eb = expressionBuilder<DB, "cache_entries">();
  return eb
    .case()
    .when(jsonValid(db, eb.ref("value_json")))
    .then(jsonPathValue(db, eb.ref("value_json"), sql.lit(`$.${field}`)))
    .end();
}

/** The partial indexes exclude closed/invalid JSON before any payload reaches the decoder. */
function lookupOpenVoiceSessions(
  database: Pick<OpenClawAgentDatabase, "db">,
  input: VoiceSessionLookup,
): VoiceSessionMatch[] {
  let query = voiceSessionRowsQuery(database).where(
    voiceSessionField(database.db, "status"),
    "=",
    sql.lit("open"),
  );
  if (input.kind === "legacy") {
    query = query
      .where(voiceSessionField(database.db, "agentId"), "=", input.agentId)
      .where(voiceSessionField(database.db, "sessionKey"), "=", input.sessionKey)
      .where(voiceSessionField(database.db, "origin"), "=", "client");
  } else {
    query = query.where("updated_at", "<=", input.updatedBefore);
    if (input.excludeVoiceSessionId !== undefined) {
      query = query.where(
        voiceSessionField(database.db, "voiceSessionId"),
        "!=",
        input.excludeVoiceSessionId,
      );
    }
  }
  const matches: VoiceSessionMatch[] = [];
  for (const row of iterateSqliteQuerySync(database.db, query)) {
    const record = parseStoredVoiceSessionRecord(row.value_json);
    if (record) {
      matches.push({ voiceSessionId: record.voiceSessionId, sessionKey: record.sessionKey });
      // Invalid records do not count toward legacy ambiguity.
      if (input.kind === "legacy" && matches.length === 2) {
        break;
      }
    }
  }
  return matches;
}

/** Decode candidates inside the existing agent history reader. */
export function readOpenVoiceSessions(
  options: OpenClawAgentDatabaseOptions,
  input: VoiceSessionLookup,
) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => lookupOpenVoiceSessions(database, input),
    options,
  );
  return { kind: "voice-sessions" as const, matches: result.found ? result.value : [] };
}
