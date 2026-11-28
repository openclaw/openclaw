import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  jsonFirstStringValue,
  jsonNativeFieldsValid,
  jsonObjectFieldsForScan,
  jsonScannedValue,
} from "../../infra/database-engine/json-values.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { scanJsonObjectFields } from "../../state/json-predicate-fields.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import {
  readTranscriptEventId,
  type SqliteTranscriptStorageRow,
} from "./session-accessor.sqlite-read.js";
import { getSessionKysely, type ResolvedTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { readMessageIdempotencyKey } from "./transcript-message-identity.js";
import { transcriptEventNavigationSql } from "./transcript-payload.js";

export type IncrementalSuffixIdempotencyMutation = {
  suffixIdentityKeys: readonly (readonly [string, string | null])[];
  replacementByIdempotencyKey: readonly (readonly [string, string])[];
};

/** Prepares idempotency-owner changes before the bounded suffix write transaction. */
export function prepareIncrementalSuffixIdempotencyMutation(params: {
  database: OpenClawAgentDatabase;
  expectedRows: readonly SqliteTranscriptStorageRow[];
  next: readonly TranscriptEvent[];
  resolved: ResolvedTranscriptScope;
  startSeq: number;
}): IncrementalSuffixIdempotencyMutation {
  const db = getSessionKysely(params.database.db);
  const suffixIdentityKeys = executeSqliteQuerySync(
    params.database.db,
    db
      .selectFrom("transcript_event_identities")
      .select(["event_id", "message_idempotency_key"])
      .where("session_id", "=", params.resolved.sessionId)
      .where("seq", ">=", params.startSeq)
      .orderBy("seq", "asc")
      .limit(params.expectedRows.length + 1),
  ).rows.map((row) => [row.event_id, row.message_idempotency_key] as const);
  if (suffixIdentityKeys.length > params.expectedRows.length) {
    throw new Error(
      `SQLite transcript changed while preparing suffix removal for ${params.resolved.sessionId}`,
    );
  }
  const suffixIdentityMap = new Map(suffixIdentityKeys);
  const retainedIdempotencyKeys = new Set(
    params.next.flatMap((event) => {
      const eventId = readTranscriptEventId(event);
      const storedKey = eventId ? suffixIdentityMap.get(eventId) : undefined;
      const nextKey = isRecord(event) ? readMessageIdempotencyKey(event.message) : null;
      return storedKey && storedKey === nextKey ? [storedKey] : [];
    }),
  );
  const removedIdempotencyKeys = new Set(
    suffixIdentityKeys.flatMap(([, key]) =>
      key && !retainedIdempotencyKeys.has(key) ? [key] : [],
    ),
  );
  const removedKeys = [...removedIdempotencyKeys];
  if (removedKeys.length === 0) {
    return { suffixIdentityKeys, replacementByIdempotencyKey: [] };
  }
  const trimCharacters =
    " \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
  const event = transcriptEventNavigationSql(params.database.db, "event");
  const extractedKey =
    /* kysely-allow-raw: select the canonical message idempotency key without hydrating prefix events. */
    sql<
      string | null
    >`trim(${jsonFirstStringValue(params.database.db, event, ["message", "idempotencyKey"])}, ${trimCharacters})`;
  const candidates = executeSqliteQuerySync(
    params.database.db,
    db
      .with("candidates", (query) =>
        query
          .selectFrom("transcript_event_identities as identity")
          .innerJoin("transcript_events as event", (join) =>
            join
              .onRef("event.session_id", "=", "identity.session_id")
              .onRef("event.seq", "=", "identity.seq"),
          )
          .select([
            "identity.event_id",
            "identity.seq",
            extractedKey.as("idempotency_key"),
            event.as("event_json"),
          ])
          .where("identity.session_id", "=", params.resolved.sessionId)
          .where("identity.seq", "<", params.startSeq)
          .where("identity.message_idempotency_key", "is", null)
          .where("event.navigation_valid", "=", 1)
          .where((eb) =>
            eb.or([
              eb(extractedKey, "in", removedKeys),
              eb.not(jsonNativeFieldsValid(params.database.db, event)),
            ]),
          ),
      )
      .with("latest", (query) =>
        query
          .selectFrom("candidates")
          .select([
            "idempotency_key",
            /* kysely-allow-raw: select one native-decoded replacement per removed key. */
            sql<number>`max(seq)`.as("seq"),
          ])
          .where("idempotency_key", "is not", null)
          .groupBy("idempotency_key"),
      )
      .selectFrom("candidates")
      .leftJoin("latest", (join) =>
        join
          .onRef("latest.idempotency_key", "=", "candidates.idempotency_key")
          .onRef("latest.seq", "=", "candidates.seq"),
      )
      .select([
        "candidates.event_id",
        "candidates.idempotency_key",
        jsonObjectFieldsForScan(
          params.database.db,
          /* kysely-allow-raw: closed CTE alias carries the retained candidate metadata. */
          sql.ref<string>("candidates.event_json"),
          { message: { idempotencyKey: true } },
        ).as("event_json"),
      ])
      .where((eb) =>
        eb.or([eb("candidates.idempotency_key", "is", null), eb("latest.seq", "is not", null)]),
      )
      .orderBy("candidates.seq", "desc"),
  ).rows;
  const replacements = new Map<string, string>();
  for (const row of candidates) {
    let key = row.idempotency_key;
    if (key === null) {
      const root = scanJsonObjectFields(row.event_json, ["message"]);
      const message = root.first.get("message");
      if (!root.valid || message?.kind !== "object") {
        continue;
      }
      const fields = scanJsonObjectFields(message.text, ["idempotencyKey"]);
      const value = jsonScannedValue(fields.first.get("idempotencyKey"));
      key = typeof value === "string" ? value.trim() : null;
    }
    if (key !== null && removedIdempotencyKeys.has(key) && !replacements.has(key)) {
      replacements.set(key, row.event_id);
    }
  }
  return {
    suffixIdentityKeys,
    replacementByIdempotencyKey: [...replacements],
  };
}
