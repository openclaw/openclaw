import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  isCacheTtlTouch,
  readCacheTtlCheckpoint,
} from "../../agents/embedded-agent-runner/cache-ttl-checkpoint.js";
import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import type {
  CacheTtlProjectionPrefix,
  SessionTranscriptBoundedActiveContext,
} from "./session-accessor.sqlite-contract.js";
import {
  getActiveTranscriptKysely,
  type CurrentTranscriptProjection,
} from "./session-accessor.sqlite-projection-read.js";
import { isIndexedSessionEntry } from "./session-entry-codec.js";
import {
  transcriptEventJsonSql,
  transcriptEventModelNavigationSql,
  transcriptEventResetNavigationSql,
} from "./transcript-payload.js";

/** Projection dependencies are metadata, separate from the byte-bounded model history. */
export function readCacheTtlProjectionPrefix(
  projection: CurrentTranscriptProjection,
  anchor:
    | { activePosition: number; id: string; entry: Record<string, unknown>; beforeRawSeq?: number }
    | undefined,
): CacheTtlProjectionPrefix | undefined {
  // Every retained branch can end at the anchor, before any later checkpoint.
  if (
    !anchor ||
    (isIndexedSessionEntry(anchor.entry) &&
      (anchor.entry.type === "reset" || readCacheTtlCheckpoint([anchor.entry])))
  ) {
    return undefined;
  }
  const lastNavigationValue = (key: "type" | "customType") =>
    /* kysely-allow-raw: legacy duplicate members follow JSON.parse's last-key semantics. */
    sql`(SELECT value FROM json_each(${transcriptEventResetNavigationSql("event")})
      WHERE key = ${key} ORDER BY id DESC LIMIT 1)`;
  const entryType =
    /* kysely-allow-raw: exact-row identities carry the parsed kind; legacy rows retain native navigation. */
    sql`coalesce(identity.event_type, ${lastNavigationValue("type")})`;
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
              eb(entryType, "=", "reset"),
              eb.and([
                eb(entryType, "=", "custom"),
                eb(lastNavigationValue("customType"), "=", "openclaw.cache-ttl"),
              ]),
            ]),
          )
          .end(),
      )
      .orderBy("active.active_position", "desc"),
  );
  const prefix: Record<string, unknown>[] = [];
  for (const row of rows) {
    const entry = asOptionalRecord(JSON.parse(row.event_json));
    if (
      !isIndexedSessionEntry(entry) ||
      (entry.type !== "reset" && (entry.type !== "custom" || isCacheTtlTouch(entry.data)))
    ) {
      continue;
    }
    prefix.push(entry);
    if (entry.type === "reset" || readCacheTtlCheckpoint([entry])) {
      break;
    }
  }
  return prefix.length ? { anchorIds: [anchor.id], entries: prefix.toReversed() } : undefined;
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
