/** Offline SQLite recovery preserves journals before moving the main pathname. */
import fs from "node:fs";
import { resolveSqliteDatabaseFilePaths } from "./sqlite-files.js";

export function moveSqliteFilesAside(
  sqlitePath: string,
  assertCurrent: () => void,
): {
  movedFiles: string[];
  skippedFiles: string[];
} {
  const recoveryFiles = inspectSqliteRecoveryFiles(sqlitePath);
  const moves = planSqliteRecoveryMoves(recoveryFiles.existing);
  const completed: typeof moves = [];
  try {
    // Preserve every journal before removing the main pathname. Recovery is
    // offline; rollback restores the set after a caught rename failure.
    for (const move of moves.toSorted((left, right) => {
      if (left.sourcePath === sqlitePath) {
        return 1;
      }
      if (right.sourcePath === sqlitePath) {
        return -1;
      }
      return left.sourcePath.localeCompare(right.sourcePath);
    })) {
      assertCurrent();
      fs.renameSync(move.sourcePath, move.destinationPath);
      completed.push(move);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    const preservedPaths: string[] = [];
    for (const move of completed.toReversed()) {
      try {
        assertCurrent();
        if (fs.lstatSync(move.sourcePath, { throwIfNoEntry: false })) {
          throw new Error(`rollback source was recreated: ${move.sourcePath}`, {
            cause: error,
          });
        }
        fs.renameSync(move.destinationPath, move.sourcePath);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
        preservedPaths.push(move.destinationPath);
      }
    }
    if (rollbackErrors.length > 0) {
      const rollbackDetails = rollbackErrors
        .map((rollbackError) => String(rollbackError))
        .join("; ");
      throw new Error(
        `Could not move corrupt SQLite file set aside or restore it: ${sqlitePath}; rollback failures: ${rollbackDetails}. Preserved recovery files: ${preservedPaths.join(", ")}`,
        { cause: error },
      );
    }
    throw error;
  }
  return {
    movedFiles: moves.map((move) => move.destinationPath),
    skippedFiles: recoveryFiles.missing,
  };
}

export function inspectSqliteRecoveryFiles(sqlitePath: string): {
  existing: string[];
  missing: string[];
} {
  const existing: string[] = [];
  const missing: string[] = [];
  for (const candidate of resolveSqliteDatabaseFilePaths(sqlitePath)) {
    const stat = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (!stat) {
      missing.push(candidate);
    } else if (!stat.isFile()) {
      throw new Error(`SQLite recovery path is not a regular file: ${candidate}`);
    } else {
      existing.push(candidate);
    }
  }
  return { existing, missing };
}

export function planSqliteRecoveryMoves(
  sourcePaths: readonly string[],
): Array<{ destinationPath: string; sourcePath: string }> {
  const timestampSuffix = `.corrupt-${Date.now()}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = attempt === 0 ? timestampSuffix : `${timestampSuffix}.${attempt}`;
    const moves = sourcePaths.map((sourcePath) => ({
      destinationPath: `${sourcePath}${suffix}`,
      sourcePath,
    }));
    if (moves.every((move) => !fs.lstatSync(move.destinationPath, { throwIfNoEntry: false }))) {
      return moves;
    }
  }
  throw new Error(`Could not choose recovery paths for ${sourcePaths[0] ?? "SQLite files"}`);
}
