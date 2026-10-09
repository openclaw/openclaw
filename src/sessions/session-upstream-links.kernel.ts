import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { safeParseJson } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type {
  SessionUpstreamJsonValue,
  SessionUpstreamKind,
} from "../plugins/session-catalog-upstream.types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import type { WorkerOperationHandlers } from "../state/worker-operation-registry.js";

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

function rowToSessionUpstreamLink(row: SessionUpstreamLinkRow): SessionUpstreamLink {
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

export function readSessionUpstreamLinkInDatabase(
  db: DatabaseSync,
  sessionKey: string,
  agentId: string,
): SessionUpstreamLink | undefined {
  const row = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_upstream_links">>(db)
      .selectFrom("session_upstream_links")
      .selectAll()
      .where("session_key", "=", sessionKey)
      .where("agent_id", "=", agentId),
  ).rows[0];
  return row ? rowToSessionUpstreamLink(row) : undefined;
}

export const sessionUpstreamReadOperations = {
  "sessionUpstream.read": (input: { sessionKey: string; agentId: string }, db) => ({
    type: "sessionUpstream.read" as const,
    link: readSessionUpstreamLinkInDatabase(db, input.sessionKey, input.agentId),
  }),
} satisfies WorkerOperationHandlers<DatabaseSync>;

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

export type SessionUpstreamLinkInput = Omit<
  SessionUpstreamLink,
  "lastScannedAt" | "createdAt" | "updatedAt"
>;

function getSessionUpstreamKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "session_upstream_links">>(db);
}

export function upsertSessionUpstreamLinkInDatabase(
  db: DatabaseSync,
  input: SessionUpstreamLinkInput,
  now: number,
  ifAbsent?: true,
): boolean {
  return (
    executeSqliteQuerySync(
      db,
      getSessionUpstreamKysely(db)
        .insertInto("session_upstream_links")
        .values({
          session_key: input.sessionKey,
          agent_id: input.agentId,
          catalog_id: input.catalogId,
          host_id: input.hostId,
          thread_id: input.threadId,
          upstream_kind: input.upstreamKind,
          upstream_ref_json: JSON.stringify(input.upstreamRef),
          last_marker_json: JSON.stringify(input.marker),
          last_scanned_at: null,
          created_at: now,
          updated_at: now,
        })
        .onConflict((conflict) =>
          ifAbsent
            ? conflict.columns(["session_key", "agent_id"]).doNothing()
            : conflict.columns(["session_key", "agent_id"]).doUpdateSet((eb) => {
                // Same-source refresh preserves scan progress; any identity change
                // (thread/host/kind or the physical ref: Claude filePath, Codex
                // connection fingerprint) must rebase the cursor to the new baseline
                // or the old source's marker would misread the new upstream.
                const sourceChanged = eb.or([
                  eb("session_upstream_links.thread_id", "!=", eb.ref("excluded.thread_id")),
                  eb("session_upstream_links.host_id", "!=", eb.ref("excluded.host_id")),
                  eb(
                    "session_upstream_links.upstream_kind",
                    "!=",
                    eb.ref("excluded.upstream_kind"),
                  ),
                  eb(
                    "session_upstream_links.upstream_ref_json",
                    "!=",
                    eb.ref("excluded.upstream_ref_json"),
                  ),
                ]);
                return {
                  agent_id: input.agentId,
                  catalog_id: input.catalogId,
                  host_id: input.hostId,
                  thread_id: input.threadId,
                  upstream_kind: input.upstreamKind,
                  upstream_ref_json: JSON.stringify(input.upstreamRef),
                  last_marker_json: eb
                    .case()
                    .when(sourceChanged)
                    .then(JSON.stringify(input.marker))
                    .else(eb.ref("session_upstream_links.last_marker_json"))
                    .end(),
                  last_scanned_at: eb
                    .case()
                    .when(sourceChanged)
                    .then(null)
                    .else(eb.ref("session_upstream_links.last_scanned_at"))
                    .end(),
                  updated_at: now,
                };
              }),
        ),
    ).numAffectedRows === 1n
  );
}

export function deleteSessionUpstreamLinkInDatabase(
  db: DatabaseSync,
  sessionKey: string,
  agentId: string,
  expected?: SessionUpstreamLink,
): "deleted" | "absent" | "changed" {
  if (expected) {
    const current = readSessionUpstreamLinkInDatabase(db, sessionKey, agentId);
    if (!current) {
      return "absent";
    }
    if (!isDeepStrictEqual(current, expected)) {
      return "changed";
    }
  }
  executeSqliteQuerySync(
    db,
    getSessionUpstreamKysely(db)
      .deleteFrom("session_upstream_links")
      .where("session_key", "=", sessionKey)
      .where("agent_id", "=", agentId),
  );
  return "deleted";
}

export function sessionUpstreamLinkSourceMatches(
  current: SessionUpstreamLink | undefined,
  expected: SessionUpstreamLink,
): boolean {
  return (
    current !== undefined &&
    current.sessionKey === expected.sessionKey &&
    current.agentId === expected.agentId &&
    current.catalogId === expected.catalogId &&
    current.hostId === expected.hostId &&
    current.threadId === expected.threadId &&
    current.upstreamKind === expected.upstreamKind &&
    isDeepStrictEqual(current.upstreamRef, expected.upstreamRef)
  );
}
