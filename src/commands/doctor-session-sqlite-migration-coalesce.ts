import type { DoctorSessionSqliteIssue } from "../infra/session-sqlite-migration-issues.js";
/** Manifest-owned redirection of verified redundant archive references. */
import {
  HISTORICAL_IMPORT_REASON,
  migrationMoveKey,
  sessionSqliteMigrationTargetKey,
  uniqueRestoreMoves,
  writeSessionSqliteMigrationManifest,
  type ActiveSessionSqliteMigrationRun,
  type SessionSqliteMigrationMove,
  type SessionSqliteMigrationTargetInput,
} from "../infra/session-sqlite-migration-manifest.js";

/** Publish settlement-verified replacements without removing any run's rollback coverage. */
export function coalesceSessionSqliteArchiveReferences(
  replacements: ReadonlyMap<string, SessionSqliteMigrationMove>,
  runs: readonly ActiveSessionSqliteMigrationRun[],
): Array<{ target: SessionSqliteMigrationTargetInput; issues: DoctorSessionSqliteIssue[] }> {
  const results = new Map<
    string,
    {
      target: SessionSqliteMigrationTargetInput;
      issues: DoctorSessionSqliteIssue[];
      archives: Set<string>;
    }
  >();
  const changed = new Set<ActiveSessionSqliteMigrationRun>();
  const originalsByPath = new Map<string, string[]>();
  for (const [original, survivor] of replacements) {
    for (const path of [original, survivor.archivePath]) {
      const originals = originalsByPath.get(path) ?? [];
      originals.push(original);
      originalsByPath.set(path, originals);
    }
  }
  for (const run of runs) {
    for (const target of run.manifest.targets) {
      const settled = new Set<string>();
      for (const move of uniqueRestoreMoves(target)) {
        for (const original of originalsByPath.get(move.archivePath) ?? []) {
          settled.add(original);
        }
      }
      if (settled.size === 0) {
        continue;
      }
      const key = sessionSqliteMigrationTargetKey(target);
      const result = results.get(key) ?? {
        target,
        archives: new Set<string>(),
        issues: [{ code: "historical_duplicate_settled", message: "" }],
      };
      results.set(key, result);
      settled.forEach((original) => result.archives.add(original));
      target.issues.push(...result.issues);
      for (const list of ["plannedMoves", "completedMoves"] as const) {
        const moves = new Map<string, SessionSqliteMigrationMove>();
        for (const move of target[list]) {
          const survivor = replacements.get(move.archivePath);
          if (survivor && move.artifact) {
            move.archivePath = survivor.archivePath;
            move.artifact = {
              ...move.artifact,
              identity: survivor.artifact!.identity,
              disposal: { state: "retained" },
            };
          }
          const moveKey = migrationMoveKey(move);
          // Keep acknowledgment after explicit session deletion; never resurrect coalesced history.
          if (moves.get(moveKey)?.artifact?.reason !== HISTORICAL_IMPORT_REASON) {
            moves.set(moveKey, move);
          }
        }
        target[list] = [...moves.values()];
      }
      changed.add(run);
    }
  }
  for (const { archives, issues } of results.values()) {
    issues[0]!.message = `Retired ${archives.size} byte-identical duplicate archive(s); rollback references now use the verified surviving originals.`;
  }
  for (const run of changed) {
    writeSessionSqliteMigrationManifest(run);
  }
  return [...results.values()].map(({ target, issues }) => ({ target, issues }));
}
