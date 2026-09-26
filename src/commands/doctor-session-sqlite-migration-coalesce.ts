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
} from "./doctor-session-sqlite-migration-run.js";
import type { DoctorSessionSqliteIssue } from "./doctor-session-sqlite-types.js";

/** Replace retired duplicate references without removing any run's rollback coverage. */
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
  for (const run of runs) {
    for (const target of run.manifest.targets) {
      const paths = new Set(uniqueRestoreMoves(target).map((move) => move.archivePath));
      const settled = [...replacements].filter(
        ([original, survivor]) => paths.has(original) || paths.has(survivor.archivePath),
      );
      if (settled.length === 0) {
        continue;
      }
      const key = sessionSqliteMigrationTargetKey(target);
      const result = results.get(key) ?? {
        target,
        archives: new Set<string>(),
        issues: [{ code: "historical_duplicate_settled", message: "" }],
      };
      results.set(key, result);
      settled.forEach(([original]) => result.archives.add(original));
      target.issues.push(...result.issues);
      for (const list of ["plannedMoves", "completedMoves"] as const) {
        const moves = new Map<string, SessionSqliteMigrationMove>();
        for (const move of target[list]) {
          const survivor = replacements.get(move.archivePath);
          if (survivor && move.artifact?.disposal.state === "disposed") {
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
