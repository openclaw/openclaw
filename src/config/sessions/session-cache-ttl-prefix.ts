import { sql } from "kysely";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  CacheTtlProjectionPrefix,
  SessionTranscriptBoundedActiveContext,
} from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { collectCacheTtlProjectionPrefix } from "./session-cache-ttl-prefix-values.js";
import { transcriptEventJsonSql, transcriptEventModelNavigationSql } from "./transcript-payload.js";
import { assertTranscriptNavigationValid } from "./transcript-predicate-fields.js";

/** Projection dependencies are metadata, separate from the byte-bounded model history. */
export function readCacheTtlProjectionPrefix(
  projection: CurrentTranscriptProjection,
  anchor:
    | { activePosition: number; id: string; entry: Record<string, unknown>; beforeRawSeq?: number }
    | undefined,
): CacheTtlProjectionPrefix | undefined {
  if (!anchor) {
    return undefined;
  }
  const entryType =
    /* kysely-allow-raw: exact-row identities carry the parsed kind; legacy rows retain native navigation. */
    sql`coalesce(identity.event_type, event.navigation_last_type)`;
  const rows = iterateSqliteQuerySync(
    projection.database.db,
    getActiveTranscriptKysely(projection.database)
      .selectFrom("session_transcript_active_events as active")
      .innerJoin("transcript_events as event", (join) =>
        join
          .onRef("event.session_id", "=", "active.session_id")
          .onRef("event.seq", "=", "active.event_seq"),
      )
      .leftJoin("transcript_event_identities as identity", (join) =>
        join
          .onRef("identity.session_id", "=", "active.session_id")
          .onRef("identity.seq", "=", "active.event_seq"),
      )
      .select((eb) =>
        eb
          .case()
          .when(entryType, "=", "reset")
          // Preserve the classified kind when legacy JSON starts with another duplicate type.
          .then(transcriptEventModelNavigationSql("event", sql.lit("reset")))
          .else(transcriptEventJsonSql(projection.database.db, "event"))
          .end()
          .as("event_json"),
      )
      .select("event.navigation_valid")
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
              eb("event.navigation_valid", "=", 0),
              eb(entryType, "=", "reset"),
              eb.and([
                eb(entryType, "=", "custom"),
                eb("event.navigation_last_custom_type", "=", "openclaw.cache-ttl"),
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
        yield JSON.parse(row.event_json) as unknown;
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
