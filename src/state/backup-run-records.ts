import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  resolveBackupRunNamespace,
  resolveBackupRunTarget,
  serializeBackupRunManifest,
  type BackupRunManifest,
  type BackupRunRecord,
} from "./backup-run-records.contract.js";
import {
  executeExistingOpenClawStateRead,
  isOpenClawStateDatabaseDefinitelyAbsent,
} from "./openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "./openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";

export type {
  BackupRunRecord,
  BackupRunLocation,
  BackupRunRetention,
} from "./backup-run-records.contract.js";
export type BackupRunFreshness = {
  latest?: BackupRunRecord;
  latestOk?: BackupRunRecord;
  latestOffsite?: BackupRunRecord;
};

/** Record one best-effort backup outcome in the shared bounded operational log. */
export async function recordBackupRunOutcome(
  params: {
    archivePath: string;
    status: "ok" | "failed";
    pushFailed?: boolean;
    createdAt?: number;
    env?: NodeJS.ProcessEnv;
  } & Omit<BackupRunManifest, "pushFailed">,
  options?: { assertCurrent?: () => void; signal?: AbortSignal },
): Promise<void> {
  const databasePath = resolveOpenClawStateSqlitePath(params.env ?? process.env);
  // Best-effort log only: never bootstrap an absent state database to record an
  // outcome, or a failed backup on a fresh host would create a blank DB that a
  // retry then treats as real backup input.
  if (!existsSync(databasePath)) {
    return;
  }
  const context = captureOpenClawStateWorkerContext({ path: databasePath, env: params.env });
  const manifest = serializeBackupRunManifest({
    ...params,
    pushFailed: params.pushFailed === true ? true : undefined,
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
    { ...options, existingOnly: true },
  );
}

/** Read ledger rows through the shared SQLite read worker without bootstrapping state. */
export async function readBackupRuns(env: NodeJS.ProcessEnv): Promise<BackupRunRecord[]> {
  if (isOpenClawStateDatabaseDefinitelyAbsent(env)) {
    return [];
  }
  const result = await executeExistingOpenClawStateRead(
    { env, path: resolveOpenClawStateSqlitePath(env) },
    { type: "backup.runs" },
  );
  if (!result) {
    return [];
  }
  if (!result.ok) {
    throw new Error(result.message);
  }
  if (result.type !== "backup.runs") {
    throw new Error("Unexpected backup ledger read result");
  }
  return result.runs;
}

export function summarizeBackupFreshness(runs: readonly BackupRunRecord[]): BackupRunFreshness {
  const latest = runs[0];
  const latestOk = runs.find((run) => run.status === "ok");
  const latestOffsite = runs.find((run) => run.kind === "archive" && (run.location || run.target));
  return {
    ...(latest ? { latest } : {}),
    ...(latestOk ? { latestOk } : {}),
    ...(latestOffsite ? { latestOffsite } : {}),
  };
}

/** Read backup freshness without creating or repairing an absent state database. */
export async function readBackupRunFreshness(env: NodeJS.ProcessEnv): Promise<BackupRunFreshness> {
  return summarizeBackupFreshness(await readBackupRuns(env));
}

export function summarizeBackupTargets(runs: readonly BackupRunRecord[]) {
  const groups = new Map<
    string,
    {
      kind: BackupRunRecord["kind"];
      target: string;
      namespace?: string;
      latest: BackupRunRecord;
      latestOk?: BackupRunRecord;
    }
  >();
  for (const run of runs) {
    const target = run.location?.name ?? resolveBackupRunTarget(run);
    const namespace = resolveBackupRunNamespace(run);
    const key = JSON.stringify([run.kind, target, namespace]);
    let group = groups.get(key);
    if (!group) {
      group = {
        kind: run.kind,
        target: target ?? run.archivePath,
        ...(namespace === undefined ? {} : { namespace }),
        latest: run,
      };
      groups.set(key, group);
    }
    if (run.status === "ok" && !group.latestOk) {
      group.latestOk = run;
    }
  }
  return [...groups.values()];
}

/** Archive parents are the fallback scratch roots when TMPDIR overlaps a source. */
export async function readBackupArchiveDirectories(env: NodeJS.ProcessEnv): Promise<string[]> {
  return [
    ...new Set(
      (await readBackupRuns(env)).flatMap((record) =>
        record.kind === "archive" && path.isAbsolute(record.archivePath)
          ? [path.dirname(record.archivePath)]
          : [],
      ),
    ),
  ];
}
