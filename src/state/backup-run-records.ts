import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { BACKUP_RUN_ERROR_MAX_LENGTH } from "./backup-run-records.contract.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "./openclaw-state-db-readonly.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "./openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

type BackupRunDatabase = Pick<OpenClawStateDatabase, "backup_runs">;

type BackupRunKind = "archive" | "sqlite-snapshot" | "git";

type BackupRunRecord = {
  id: string;
  createdAt: number;
  archivePath: string;
  status: "ok" | "failed";
  kind: BackupRunKind;
  target?: string;
  error?: string;
  pushFailed?: true;
};

export type BackupRunFreshness = {
  latest?: BackupRunRecord;
  latestOk?: BackupRunRecord;
};

function boundedText(value: string | undefined, maxLength: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? truncateUtf16Safe(trimmed, maxLength) : undefined;
}

function parseBackupRun(row: BackupRunDatabase["backup_runs"]): BackupRunRecord | undefined {
  if (row.status !== "ok" && row.status !== "failed") {
    return undefined;
  }
  const manifest = safeParseJsonRecord(row.manifest_json);
  if (!manifest) {
    return undefined;
  }
  if (
    manifest.kind !== "archive" &&
    manifest.kind !== "sqlite-snapshot" &&
    manifest.kind !== "git"
  ) {
    return undefined;
  }
  return {
    id: row.id,
    createdAt: row.created_at,
    archivePath: row.archive_path,
    status: row.status,
    kind: manifest.kind,
    ...(typeof manifest.target === "string" ? { target: manifest.target } : {}),
    ...(typeof manifest.error === "string" ? { error: manifest.error } : {}),
    ...(manifest.pushFailed === true ? { pushFailed: true } : {}),
  };
}

/** Record one best-effort backup outcome in the shared bounded operational log. */
export async function recordBackupRunOutcome(params: {
  archivePath: string;
  status: "ok" | "failed";
  kind: BackupRunKind;
  target?: string;
  error?: string;
  pushFailed?: boolean;
  createdAt?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const databasePath = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  // Best-effort log only: never bootstrap an absent state database to record an
  // outcome, or a failed backup on a fresh host would create a blank DB that a
  // retry then treats as real backup input.
  if (!existsSync(databasePath)) {
    return;
  }
  const context = captureOpenClawStateWorkerContext({ path: databasePath, env: params.env });
  const manifest = JSON.stringify({
    kind: params.kind,
    target: boundedText(params.target, 512),
    error: boundedText(params.error, BACKUP_RUN_ERROR_MAX_LENGTH),
    ...(params.pushFailed === true ? { pushFailed: true } : {}),
  });
  const row = {
    id: randomUUID(),
    created_at: params.createdAt ?? Date.now(),
    archive_path: params.archivePath,
    status: params.status,
    manifest_json: manifest,
  };
  const { runOpenClawStateWorkerOperation } = await import("./openclaw-state-worker-store.js");
  await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute({ type: "backup.recordOutcome", input: row }),
    { existingOnly: true },
  );
}

function readBackupRun(database: DatabaseSync, status?: "ok"): BackupRunRecord | undefined {
  // backup_runs is same-version additive: an older v6 database may not have it
  // until a writable open converges the schema. Read-only freshness paths must
  // treat that as "no recorded backups", never as an error.
  if (!tableExists(database, "backup_runs")) {
    return undefined;
  }
  const kysely = getNodeSqliteKysely<BackupRunDatabase>(database);
  let query = kysely.selectFrom("backup_runs").selectAll();
  if (status) {
    query = query.where("status", "=", status);
  }
  const row = executeSqliteQueryTakeFirstSync(
    database,
    query.orderBy("created_at", "desc").orderBy("id", "desc").limit(1),
  );
  return row ? parseBackupRun(row) : undefined;
}

/** Read backup freshness without creating or repairing an absent state database. */
export async function readBackupRunFreshness(env: NodeJS.ProcessEnv): Promise<BackupRunFreshness> {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => ({ latest: readBackupRun(db), latestOk: readBackupRun(db, "ok") }),
      { env, path: resolveOpenClawStateSqlitePath(env) },
    ) ?? {}
  );
}

/** Archive parents are the fallback scratch roots when TMPDIR overlaps a source. */
export function readBackupArchiveDirectories(env: NodeJS.ProcessEnv): string[] {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => {
        if (!tableExists(db, "backup_runs")) {
          return [];
        }
        const rows = executeSqliteQuerySync(
          db,
          getNodeSqliteKysely<BackupRunDatabase>(db).selectFrom("backup_runs").selectAll(),
        ).rows;
        return [
          ...new Set(
            rows.flatMap((row) => {
              const record = parseBackupRun(row);
              return record?.kind === "archive" && path.isAbsolute(record.archivePath)
                ? [path.dirname(record.archivePath)]
                : [];
            }),
          ),
        ];
      },
      { env, path: resolveOpenClawStateSqlitePath(env) },
    ) ?? []
  );
}
