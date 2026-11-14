import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { jsonScannedValue } from "../../infra/database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import {
  readJsonPredicateScalar,
  scanJsonObjectFields,
} from "../../state/json-predicate-fields.js";
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
      .select((eb) => [
        eb("node.entry_json", "=", "{}").as("placeholder"),
        // Scan original text so unselected deep JSON cannot disappear during dialect projection.
        "node.entry_json as metadata_json",
      ])
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
    const fields = scanJsonObjectFields(row.metadata_json, [
      "updatedAt",
      "archivedAt",
      "lastInteractionAt",
      "lifecycleRevision",
      "worktree",
    ]);
    const revision = fields.first.get("lifecycleRevision");
    const worktree = fields.first.get("worktree");
    const invalidOptionalNumber = (key: "archivedAt" | "lastInteractionAt") => {
      const token = fields.first.get(key);
      return token !== undefined && token.kind !== "number";
    };
    if (
      row.entry_valid !== 1 ||
      row.pending_key !== null ||
      !fields.valid ||
      fields.maximumDepth > 1000 ||
      fields.duplicateKeys.size > 0 ||
      (revision !== undefined && revision.kind !== "string") ||
      (worktree !== undefined && worktree.kind !== "object") ||
      invalidOptionalNumber("archivedAt") ||
      invalidOptionalNumber("lastInteractionAt") ||
      jsonScannedValue(fields.first.get("updatedAt"), "numeric") !== row.updated_at ||
      jsonScannedValue(fields.first.get("archivedAt")) !== row.archived_at ||
      jsonScannedValue(fields.first.get("lastInteractionAt")) !== row.last_interaction_at
    ) {
      throw canonicalSessionKeyMigrationRequiredError(
        `invalid persisted session row requires repair for ${row.session_key}`,
      );
    }
    // The raw token retains opaque UTF-16 code units that SQLite scalar extraction replaces.
    const lifecycleRevision = readJsonPredicateScalar(revision);
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
          ...(worktree === undefined ? {} : { worktree: readWorktree(worktree.text) }),
        },
      },
    ];
  });
}
