/** Best-effort shared-state registry for adopted upstream sessions. */
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { SessionUpstreamJsonValue, SessionUpstreamKind } from "../plugins/session-catalog.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../state/openclaw-state-worker-store.js";
import {
  rowToSessionUpstreamLink,
  type SessionUpstreamLink,
} from "./session-upstream-links.kernel.js";

export type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

type SessionUpstreamDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "session_upstream_links" | "session_watch_cursors"
>;
const log = createSubsystemLogger("sessions/upstream-links");

function getSessionUpstreamKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<SessionUpstreamDatabase>(db);
}

export function upsertSessionUpstreamLink(
  input: {
    sessionKey: string;
    agentId: string;
    catalogId: string;
    hostId: string;
    threadId: string;
    upstreamKind: SessionUpstreamKind;
    upstreamRef: SessionUpstreamJsonValue;
    marker: SessionUpstreamJsonValue;
  },
  options: OpenClawStateDatabaseOptions & {
    now?: number;
    ifAbsent?: true;
    assertCommitAllowed?: () => void;
  } = {},
): boolean {
  const now = options.now ?? Date.now();
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      options.assertCommitAllowed?.();
      const written =
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
              options.ifAbsent
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
        ).numAffectedRows === 1n;
      // Revalidate before COMMIT: a lifecycle change must roll back this link write.
      options.assertCommitAllowed?.();
      return written;
    }, options);
  } catch (error) {
    if (options.ifAbsent) {
      throw error;
    }
    log.warn(`failed to upsert session upstream link: ${String(error)}`);
    return false;
  }
}

export function readSessionUpstreamLink(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): SessionUpstreamLink | undefined {
  try {
    const { db } = openOpenClawStateDatabase(options);
    const row = executeSqliteQuerySync(
      db,
      getSessionUpstreamKysely(db)
        .selectFrom("session_upstream_links")
        .selectAll()
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId),
    ).rows[0];
    return row ? rowToSessionUpstreamLink(row) : undefined;
  } catch (error) {
    log.warn(`failed to read session upstream link: ${String(error)}`);
    return undefined;
  }
}

export function updateSessionUpstreamLinkMarker(
  sessionKey: string,
  agentId: string,
  marker: SessionUpstreamJsonValue,
  options: OpenClawStateDatabaseOptions & { now?: number; expectedUpdatedAt?: number } = {},
): boolean {
  const now = options.now ?? Date.now();
  try {
    let updated = false;
    runOpenClawStateWriteTransaction(({ db }) => {
      let query = getSessionUpstreamKysely(db)
        .updateTable("session_upstream_links")
        .set({
          last_marker_json: JSON.stringify(marker),
          last_scanned_at: now,
          updated_at: now,
        })
        .where("session_key", "=", sessionKey)
        .where("agent_id", "=", agentId);
      if (options.expectedUpdatedAt !== undefined) {
        // CAS: a Continue can refresh the link mid-scan; a stale scan must not
        // clobber the refreshed source's marker with the old source's cursor.
        query = query.where("updated_at", "=", options.expectedUpdatedAt);
      }
      updated = executeSqliteQuerySync(db, query).numAffectedRows === 1n;
    }, options);
    return updated;
  } catch (error) {
    log.warn(`failed to update session upstream marker: ${String(error)}`);
    return false;
  }
}

export function deleteSessionUpstreamLink(
  sessionKey: string,
  agentId: string,
  options: OpenClawStateDatabaseOptions & {
    expected?: SessionUpstreamLink;
    assertCommitAllowed?: () => void;
  } = {},
): "deleted" | "absent" | "changed" | undefined {
  try {
    return runOpenClawStateWriteTransaction(({ db }) => {
      options.assertCommitAllowed?.();
      const kysely = getSessionUpstreamKysely(db);
      if (options.expected) {
        const row = executeSqliteQuerySync(
          db,
          kysely
            .selectFrom("session_upstream_links")
            .selectAll()
            .where("session_key", "=", sessionKey)
            .where("agent_id", "=", agentId),
        ).rows[0];
        if (!row) {
          return "absent";
        }
        if (!isDeepStrictEqual(rowToSessionUpstreamLink(row), options.expected)) {
          return "changed";
        }
      }
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_upstream_links")
          .where("session_key", "=", sessionKey)
          .where("agent_id", "=", agentId),
      );
      options.assertCommitAllowed?.();
      return "deleted";
    }, options);
  } catch (error) {
    // Exact creation compensation must report an unverified cleanup, not claim success.
    if (options.expected) {
      throw error;
    }
    log.warn(`failed to delete session upstream link: ${String(error)}`);
    return undefined;
  }
}

export async function listWatchedSessionUpstreamLinks(
  options: Pick<OpenClawStateDatabaseOptions, "path" | "env"> = {},
): Promise<Map<string, SessionUpstreamLink[]>> {
  const grouped = new Map<string, SessionUpstreamLink[]>();
  try {
    const links = await executeOpenClawStateWorker(captureOpenClawStateWorkerContext(options), {
      type: "sessionUpstream.listWatched",
      input: undefined,
    });
    // Fail closed on the single-agent-per-key invariant: the key-only cursor lookup
    // cannot disambiguate multiple agents sharing the exact same adopted key.
    // Drop every link for that key rather than probe an arbitrary agent's upstream.
    const keyCounts = new Map<string, number>();
    for (const link of links) {
      keyCounts.set(link.sessionKey, (keyCounts.get(link.sessionKey) ?? 0) + 1);
    }
    for (const link of links) {
      if ((keyCounts.get(link.sessionKey) ?? 0) > 1) {
        log.warn(
          `skipping ambiguous upstream links for ${link.sessionKey}: multiple agents adopt the same key`,
        );
        continue;
      }
      const catalogLinks = grouped.get(link.catalogId) ?? [];
      catalogLinks.push(link);
      grouped.set(link.catalogId, catalogLinks);
    }
  } catch (error) {
    log.warn(`failed to list watched session upstream links: ${String(error)}`);
  }
  return grouped;
}
