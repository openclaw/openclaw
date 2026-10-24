import { sql } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  CacheTtlProjectionPrefix,
  SessionTranscriptBoundedActiveContext,
} from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  readSnapshotEventRows,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { collectCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix-values.js";
import {
  readTranscriptPayload,
  transcriptEventModelNavigationSql,
  transcriptPredicateSql,
} from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

/** Projection dependencies are metadata, separate from the byte-bounded model history. */
export function readCacheTtlProjectionPrefix(
  projection: CurrentTranscriptProjection,
  anchor:
    | { activePosition: number; id: string; entry: Record<string, unknown>; beforeRawSeq?: number }
    | undefined,
): CacheTtlProjectionPrefix | undefined {
  if (!anchor || anchor.activePosition === 0) {
    return undefined;
  }
  const entryType =
    /* kysely-allow-raw: exact-row identities carry the parsed kind; legacy rows retain native navigation. */
    sql`coalesce(identity.event_type, ${transcriptPredicateSql(projection.database.db, "navigation_last_type", "event")})`;
  const db = getActiveTranscriptKysely(projection.database);
  const indexed = db
    .selectFrom("transcript_event_identities")
    .select(["session_id", "seq", "event_type"])
    .where("session_id", "=", projection.resolved.sessionId);
  const candidates = projection.hasUnindexedPrefix
    ? db
        .selectFrom("session_transcript_active_events as active")
        .leftJoin("transcript_event_identities as identity", (join) =>
          join
            .onRef("identity.session_id", "=", "active.session_id")
            .onRef("identity.seq", "=", "active.event_seq"),
        )
    : db
        .selectFrom(
          indexed
            .where("event_type", "in", ["custom", "reset"])
            // Keep null-kind malformed rows selectable without turning the type seek into a scan.
            .unionAll(indexed.where("event_type", "is", null))
            .as("identity"),
        )
        // Start with marker types; active-position order must not drive a full message scan.
        .crossJoin("session_transcript_active_events as active")
        .whereRef("identity.session_id", "=", "active.session_id")
        .whereRef("identity.seq", "=", "active.event_seq");
  const rows = iterateSqliteQuerySync(
    projection.database.db,
    candidates
      .crossJoin("transcript_events as event")
      .whereRef("event.session_id", "=", "active.session_id")
      .whereRef("event.seq", "=", "active.event_seq")
      .select("event.seq")
      .select((eb) =>
        eb
          .case()
          .when(entryType, "=", "reset")
          // Preserve the classified kind when legacy JSON starts with another duplicate type.
          .then(
            transcriptEventModelNavigationSql(projection.database.db, "event", sql.lit("reset")),
          )
          .else(null)
          .end()
          .as("reset_json"),
      )
      .select(
        transcriptPredicateSql(projection.database.db, "navigation_valid", "event").as(
          "navigation_valid",
        ),
      )
      .where("active.session_id", "=", projection.resolved.sessionId)
      .where("active.active_position", "<", anchor.activePosition)
      .$call((query) =>
        anchor.beforeRawSeq === undefined
          ? query
          : query.where("active.event_seq", "<", anchor.beforeRawSeq),
      )
      .where((eb) =>
        eb
          .case()
          .when("identity.event_type", "not in", ["custom", "reset"])
          .then(false)
          .else(
            eb.or([
              eb(
                transcriptPredicateSql(projection.database.db, "navigation_valid", "event"),
                "=",
                0,
              ),
              eb(entryType, "=", "reset"),
              eb.and([
                eb(entryType, "=", "custom"),
                eb(
                  transcriptPredicateSql(
                    projection.database.db,
                    "navigation_last_custom_type",
                    "event",
                  ),
                  "=",
                  "openclaw.cache-ttl",
                ),
              ]),
            ]),
          )
          .end(),
      )
      .orderBy("active.active_position", "desc"),
  );
  return collectCacheTtlProjectionPrefix(
    anchor,
    (function* () {
      for (const row of rows) {
        assertTranscriptNavigationValid(row.navigation_valid);
        // Sorting checkpoint payloads decompresses obsolete history before the first yield.
        // Fetch only consumed payloads through the owner of this same projection snapshot.
        const eventJson =
          row.reset_json ?? readTranscriptPayload(readSnapshotEventRows(projection, [row.seq])[0]!);
        yield JSON.parse(eventJson) as unknown;
      }
    })(),
  );
}

/** Bind hidden anchors while preserving every already-navigable retained boundary. */
export function bindCacheTtlProjectionPrefixes(
  bounded: Pick<
    SessionTranscriptBoundedActiveContext,
    "cacheTtlProjectionPrefixes" | "activeLeafEntryId" | "parents" | "opaqueParents"
  >,
  view: {
    getBranch(): readonly { id: string }[];
    getEntry(id: string): { id: string } | undefined;
  },
): SessionTranscriptBoundedActiveContext["cacheTtlProjectionPrefixes"] {
  const prefixes = bounded.cacheTtlProjectionPrefixes;
  if (!prefixes?.length) {
    return prefixes;
  }
  const visible = new Set(view.getBranch().map((entry) => entry.id));
  const parents = new Map([...bounded.opaqueParents, ...bounded.parents]);
  return prefixes.flatMap((prefix) => {
    if (prefix.anchorIds.some((id) => view.getEntry(id) !== undefined)) {
      return [prefix];
    }
    const seen = new Set<string>();
    let id = bounded.activeLeafEntryId;
    let anchorId: string | undefined;
    while (id && !seen.has(id)) {
      if (visible.has(id)) {
        anchorId = id;
      }
      if (prefix.anchorIds.includes(id)) {
        return [{ ...prefix, anchorIds: anchorId ? [anchorId] : [] }];
      }
      seen.add(id);
      id = parents.get(id) ?? null;
    }
    return [];
  });
}
