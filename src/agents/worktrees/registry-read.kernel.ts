import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import type {
  ManagedWorktreeOwnerKind,
  ManagedWorktreeRecord,
  ManagedWorktreeRunEndCleanup,
  ProvisionedFileState,
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
  "gc_protection_json",
] as const satisfies readonly (keyof WorktreeRow)[];
type WorktreeRecordRow = Pick<WorktreeRow, (typeof WORKTREE_RECORD_COLUMNS)[number]>;
export type WorktreeRegistryListOptions = { liveOnly?: boolean };

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
  const record: ManagedWorktreeRecord = {
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
  try {
    const protection: unknown = JSON.parse(row.gc_protection_json ?? "null");
    if (
      isRecord(protection) &&
      protection.revision === worktreeGcRevision(record) &&
      typeof protection.reason === "string"
    ) {
      record.gcProtection = protection.reason;
    }
  } catch {
    /* Invalid derived state is re-inspected. */
  }
  return record;
}

/** Registry mutations invalidate a retained decision without rewriting its derived column. */
export function worktreeGcRevision(record: ManagedWorktreeRecord): string {
  return JSON.stringify([
    record.path,
    record.repoRoot,
    record.repoFingerprint,
    record.branch,
    record.baseRef,
    record.createdAt,
    record.ownerKind,
    record.ownerId,
    record.lastActiveAt,
    record.removedAt,
    record.snapshotRef,
    record.runEndCleanup,
  ]);
}

export function getRegistryWorktreeInDatabase(
  db: DatabaseSync,
  id: string,
): ManagedWorktreeRecord | undefined {
  const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(db)
    .selectFrom("worktrees")
    .select(WORKTREE_RECORD_COLUMNS)
    .where("id", "=", id);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return row ? rowToRecord(row) : undefined;
}

export function listRegistryWorktreesInDatabase(
  db: DatabaseSync,
  options: WorktreeRegistryListOptions = {},
): ManagedWorktreeRecord[] {
  let query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(db)
    .selectFrom("worktrees")
    .select(WORKTREE_RECORD_COLUMNS)
    .orderBy("created_at", "desc")
    .orderBy("id", "asc");
  if (options.liveOnly) {
    query = query.where("removed_at", "is", null);
  }
  return executeSqliteQuerySync(db, query).rows.map(rowToRecord);
}

export function listLiveRegistryWorktreeIdsInDatabase(db: DatabaseSync): string[] {
  const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(db)
    .selectFrom("worktrees")
    .select("id")
    .where("removed_at", "is", null);
  return executeSqliteQuerySync(db, query).rows.map((row) => row.id);
}

function isProvisionedFileState(entry: unknown): entry is ProvisionedFileState {
  return (
    isRecord(entry) &&
    typeof entry.path === "string" &&
    (entry.mode === null ||
      (typeof entry.mode === "number" &&
        Number.isInteger(entry.mode) &&
        entry.mode >= 0 &&
        entry.mode <= 0o7777)) &&
    typeof entry.chunks === "number" &&
    Number.isInteger(entry.chunks) &&
    entry.chunks >= 0
  );
}

function parseProvisionedData(
  raw: string | null,
): Array<string | ProvisionedFileState> | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return undefined;
    }
    return parsed.every(
      (entry): entry is string | ProvisionedFileState =>
        typeof entry === "string" || isProvisionedFileState(entry),
    )
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function readProvisionedData(db: DatabaseSync, id: string) {
  const query = getNodeSqliteKysely<Pick<OpenClawStateKyselyDatabase, "worktrees">>(db)
    .selectFrom("worktrees")
    .select("provisioned_paths_json")
    .where("id", "=", id);
  const row = executeSqliteQuerySync(db, query).rows[0];
  return parseProvisionedData(row?.provisioned_paths_json ?? null);
}

export function getRegistryWorktreeProvisionedPathsInDatabase(
  db: DatabaseSync,
  id: string,
): string[] | undefined {
  return readProvisionedData(db, id)?.map((entry) =>
    typeof entry === "string" ? entry : entry.path,
  );
}

export function getRegistryWorktreeProvisionedStateInDatabase(
  db: DatabaseSync,
  id: string,
): ProvisionedFileState[] | undefined {
  const data = readProvisionedData(db, id);
  return data?.every((entry): entry is ProvisionedFileState => typeof entry !== "string")
    ? data
    : undefined;
}

export function getRegistryWorktreeProvisionedChunkInDatabase(
  db: DatabaseSync,
  params: { worktreeId: string; path: string; chunkIndex: number },
): Uint8Array | undefined {
  const query = getNodeSqliteKysely<
    Pick<OpenClawStateKyselyDatabase, "worktree_provisioned_file_chunks">
  >(db)
    .selectFrom("worktree_provisioned_file_chunks")
    .select("data")
    .where("worktree_id", "=", params.worktreeId)
    .where("path", "=", params.path)
    .where("chunk_index", "=", params.chunkIndex);
  return executeSqliteQuerySync(db, query).rows[0]?.data;
}
