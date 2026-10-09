import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sql } from "kysely";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { SessionEntrySummary } from "./session-accessor.types.js";
import {
  assertCanonicalSessionKeyWrite,
  canonicalSessionKeyMigrationRequiredError,
} from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

function readWorktree(value: string): NonNullable<SessionEntry["worktree"]> {
  const worktree: unknown = JSON.parse(value);
  if (
    !isRecord(worktree) ||
    typeof worktree.id !== "string" ||
    typeof worktree.branch !== "string" ||
    typeof worktree.repoRoot !== "string" ||
    (worktree.canonicalWorkspaceDir !== undefined &&
      typeof worktree.canonicalWorkspaceDir !== "string")
  ) {
    throw new Error("Session worktree metadata requires repair");
  }
  return {
    ...worktree,
    id: worktree.id,
    branch: worktree.branch,
    repoRoot: worktree.repoRoot,
    ...(worktree.canonicalWorkspaceDir === undefined
      ? {}
      : { canonicalWorkspaceDir: worktree.canonicalWorkspaceDir }),
  };
}

/** Certified node columns own GC activity; only the small cleanup identity remains in JSON. */
export function readSessionWorktreeOwnerFactsInDatabase(
  database: Pick<OpenClawAgentReadOnlyDatabase, "db">,
  sessionKeys: readonly string[],
): SessionEntrySummary[] {
  if (sessionKeys.length === 0) {
    return [];
  }
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<DB>(database.db)
      .selectFrom("session_nodes as node")
      .leftJoin("session_windows as window", (join) =>
        join
          .onRef("window.session_id", "=", "node.current_session_id")
          .onRef("window.session_key", "=", "node.session_key"),
      )
      .leftJoin(
        "session_canonical_validation_pending as pending",
        "pending.session_key",
        "node.session_key",
      )
      .select([
        "node.session_key",
        "node.current_session_id",
        "node.updated_at",
        "node.archived_at",
        "node.last_interaction_at",
        "node.entry_valid",
        "window.session_id as retained_session_id",
        "pending.session_key as pending_key",
      ])
      .select((eb) => {
        const jsonType = (field: string) =>
          eb.fn<string>("json_type", [eb.ref("node.entry_json"), eb.val(`$.${field}`)]);
        return [
          eb("node.entry_json", "=", "{}").as("placeholder"),
          // kysely-allow-raw: JSON tokens preserve opaque revision strings without SQLite UTF-8 conversion.
          sql<string | null>`${eb.ref("node.entry_json")} -> '$.lifecycleRevision'`.as(
            "lifecycle_revision_json",
          ),
          eb
            .fn<string | null>("json_extract", [eb.ref("node.entry_json"), eb.val("$.worktree")])
            .as("worktree_json"),
          eb
            .or([
              eb.exists(
                eb
                  .selectFrom(
                    // kysely-allow-raw: SQLite paths select the first duplicate member; logical JSON reads select the last.
                    sql<{ key: string }>`json_each(${eb.ref("node.entry_json")})`.as("field"),
                  )
                  .select("field.key")
                  .where("field.key", "in", [
                    "updatedAt",
                    "archivedAt",
                    "lastInteractionAt",
                    "lifecycleRevision",
                    "worktree",
                  ])
                  .groupBy("field.key")
                  .having((fields) => fields.fn.countAll(), ">", 1),
              ),
              eb(jsonType("lifecycleRevision"), "!=", "text"),
              eb(jsonType("worktree"), "!=", "object"),
              eb(jsonType("archivedAt"), "not in", ["integer", "real"]),
              eb(jsonType("lastInteractionAt"), "not in", ["integer", "real"]),
              eb(
                eb.fn<number>("json_extract", [eb.ref("node.entry_json"), eb.val("$.updatedAt")]),
                "is not",
                eb.ref("node.updated_at"),
              ),
              eb(
                eb.fn<number | null>("json_extract", [
                  eb.ref("node.entry_json"),
                  eb.val("$.archivedAt"),
                ]),
                "is not",
                eb.ref("node.archived_at"),
              ),
              eb(
                eb.fn<number | null>("json_extract", [
                  eb.ref("node.entry_json"),
                  eb.val("$.lastInteractionAt"),
                ]),
                "is not",
                eb.ref("node.last_interaction_at"),
              ),
            ])
            .as("invalid_metadata"),
        ];
      })
      .where("node.session_key", "in", sqliteStringSet(sessionKeys)),
  ).rows;
  return rows.flatMap((row) => {
    assertCanonicalSessionKeyWrite(row.session_key);
    if (
      row.entry_valid === -1 &&
      row.placeholder &&
      row.retained_session_id === row.current_session_id
    ) {
      return [];
    }
    if (row.entry_valid !== 1 || row.pending_key !== null || row.invalid_metadata) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    const lifecycleRevision: unknown =
      row.lifecycle_revision_json === null ? undefined : JSON.parse(row.lifecycle_revision_json);
    if (lifecycleRevision !== undefined && typeof lifecycleRevision !== "string") {
      throw new Error("Session lifecycle revision metadata requires repair");
    }
    return [
      {
        sessionKey: row.session_key,
        entry: {
          sessionId: row.current_session_id,
          updatedAt: row.updated_at,
          ...(row.archived_at === null ? {} : { archivedAt: row.archived_at }),
          ...(row.last_interaction_at === null
            ? {}
            : { lastInteractionAt: row.last_interaction_at }),
          ...(lifecycleRevision === undefined ? {} : { lifecycleRevision }),
          ...(row.worktree_json === null ? {} : { worktree: readWorktree(row.worktree_json) }),
        },
      },
    ];
  });
}
