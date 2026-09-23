import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanup,
} from "./types.js";

type WorktreeRow = Selectable<OpenClawStateKyselyDatabase["worktrees"]>;
export const WORKTREE_RECORD_COLUMNS = [
  "id",
  "repo_fingerprint",
  "repo_root",
  "path",
  "branch",
  "base_ref",
  "owner_kind",
  "owner_id",
  "snapshot_ref",
  "created_at",
  "last_active_at",
  "removed_at",
  "run_end_cleanup_json",
] as const satisfies readonly (keyof WorktreeRow)[];
type WorktreeRecordRow = Pick<WorktreeRow, (typeof WORKTREE_RECORD_COLUMNS)[number]>;

function parseRunEndCleanup(
  raw: string | null | undefined,
): ManagedWorktreeRunEndCleanup | undefined {
  if (raw == null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isRecord(parsed) ||
      typeof parsed.at !== "number" ||
      !Number.isInteger(parsed.at) ||
      parsed.at < 0
    ) {
      return undefined;
    }
    const at = parsed.at;
    switch (parsed.outcome) {
      case "failed":
        return typeof parsed.reason === "string" &&
          parsed.reason.length > 0 &&
          parsed.reason.length <= 500
          ? { outcome: parsed.outcome, at, reason: parsed.reason }
          : undefined;
      case "removed-lossless":
      case "retained-busy":
      case "retained-dirty":
      case "retained-unpushed":
      case "retained-provisioned-drift":
        return parsed.reason === undefined ? { outcome: parsed.outcome, at } : undefined;
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

export function rowToRecord(row: WorktreeRecordRow): ManagedWorktreeRecord {
  const runEndCleanup = parseRunEndCleanup(row.run_end_cleanup_json);
  return {
    id: row.id,
    name: row.path.split(/[\\/]/).at(-1) ?? row.id,
    repoFingerprint: row.repo_fingerprint,
    repoRoot: row.repo_root,
    path: row.path,
    branch: row.branch,
    baseRef: row.base_ref,
    // SAFETY: The shared schema constrains owner_kind to manual, workboard, or session.
    ownerKind: row.owner_kind as ManagedWorktreeOwnerKind,
    ...(row.owner_id ? { ownerId: row.owner_id } : {}),
    ...(row.snapshot_ref ? { snapshotRef: row.snapshot_ref } : {}),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    ...(row.removed_at == null ? {} : { removedAt: row.removed_at }),
    ...(runEndCleanup ? { runEndCleanup } : {}),
  };
}

export function listRegistryWorktreesInDatabase(db: DatabaseSync): ManagedWorktreeRecord[] {
  const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(db)
    .selectFrom("worktrees")
    .select(WORKTREE_RECORD_COLUMNS)
    .orderBy("created_at", "desc")
    .orderBy("id", "asc");
  return executeSqliteQuerySync(db, query).rows.map(rowToRecord);
}

export function listLiveRegistryWorktreeIdsInDatabase(db: DatabaseSync): string[] {
  const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(db)
    .selectFrom("worktrees")
    .select("id")
    .where("removed_at", "is", null);
  return executeSqliteQuerySync(db, query).rows.map((row) => row.id);
}
