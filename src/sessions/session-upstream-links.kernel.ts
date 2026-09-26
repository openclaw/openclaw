import type { DatabaseSync } from "node:sqlite";
import { safeParseJson } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { SessionUpstreamJsonValue, SessionUpstreamKind } from "../plugins/session-catalog.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";

type SessionUpstreamLinkRow = Selectable<OpenClawStateKyselyDatabase["session_upstream_links"]>;

export type SessionUpstreamLink = {
  sessionKey: string;
  agentId: string;
  catalogId: string;
  hostId: string;
  threadId: string;
  upstreamKind: SessionUpstreamKind;
  upstreamRef: SessionUpstreamJsonValue;
  marker: SessionUpstreamJsonValue | null;
  lastScannedAt?: number;
  createdAt: number;
  updatedAt: number;
};

function parseJson(value: string | null): SessionUpstreamJsonValue | null {
  if (value === null) {
    return null;
  }
  // SAFETY: JSON.parse yields only JSON values; malformed input becomes undefined.
  return (safeParseJson(value) as SessionUpstreamJsonValue | undefined) ?? null;
}

export function rowToSessionUpstreamLink(row: SessionUpstreamLinkRow): SessionUpstreamLink {
  return {
    sessionKey: row.session_key,
    agentId: row.agent_id,
    catalogId: row.catalog_id,
    hostId: row.host_id,
    threadId: row.thread_id,
    // SAFETY: The link writer persists the typed upstream kind unchanged as TEXT.
    upstreamKind: row.upstream_kind as SessionUpstreamKind,
    upstreamRef: parseJson(row.upstream_ref_json),
    marker: parseJson(row.last_marker_json),
    ...(row.last_scanned_at === null
      ? {}
      : { lastScannedAt: normalizeSqliteNumber(row.last_scanned_at) ?? 0 }),
    createdAt: normalizeSqliteNumber(row.created_at) ?? 0,
    updatedAt: normalizeSqliteNumber(row.updated_at) ?? 0,
  };
}

export function listWatchedSessionUpstreamLinksInDatabase(db: DatabaseSync): SessionUpstreamLink[] {
  // Watch cursors own demand. Their key-only lookup relies on one owning agent per
  // adopted session key, not one agent per native thread. Agent-qualified keys
  // keep separate adoptions of the same thread distinct.
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<
      Pick<OpenClawStateKyselyDatabase, "session_upstream_links" | "session_watch_cursors">
    >(db)
      .selectFrom("session_upstream_links as links")
      .selectAll("links")
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom("session_watch_cursors as cursors")
            .select("cursors.target_session_key")
            .whereRef("cursors.target_session_key", "=", "links.session_key"),
        ),
      )
      .orderBy("links.catalog_id", "asc")
      .orderBy("links.session_key", "asc"),
  ).rows;
  return rows.map(rowToSessionUpstreamLink);
}
