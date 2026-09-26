import { openNodeSqliteDatabase, resolveSqliteFilesystemPath } from "./node-sqlite.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { createVerifiedSqliteSnapshot, type SqliteSnapshotValidator } from "./sqlite-snapshot.js";

/** Snapshot the selected live source; never accept an independently supplied payload.
 * The returned native guard retains the snapshot operation's expected content. */
export async function captureUpdateRecoverySourceSnapshot(params: {
  sourcePath: string;
  targetPath: string;
  assertCurrent: () => void;
  validate?: SqliteSnapshotValidator;
}): Promise<() => void> {
  const { sourcePath, targetPath, assertCurrent, validate } = params;
  assertCurrent();
  const frozen = await prepareSqliteReadOnlyLocation(sourcePath, {
    preserveSourceArtifacts: true,
  });
  let assertSnapshot: (() => void) | undefined;
  let cleanupFailed: boolean;
  try {
    await createVerifiedSqliteSnapshot({
      sourcePath: resolveSqliteFilesystemPath(frozen.location),
      targetPath,
      preserveRowIds: true,
      beforePublish: assertCurrent,
      afterPublish(guard) {
        guard.assertTargetMatchesExpectedContent(assertCurrent);
        assertSnapshot = () => guard.assertTargetMatchesExpectedContent(assertCurrent);
      },
      validate: validate
        ? (database, label) => {
            // The snapshot owner invokes validation on its writable staging
            // handle before fixing expected content. Never lend that handle to
            // a source validator: validation cannot become a C transformation.
            const rows = database.prepare("PRAGMA database_list").all(); // sqlite-allow-raw -- Select the actual native snapshot handle, not the diagnostic target label.
            const filename = rows.find((row) => row.name === "main")?.file;
            if (typeof filename !== "string" || !filename) {
              throw new Error("Source validation requires the actual snapshot database.");
            }
            assertCurrent();
            const reader = openNodeSqliteDatabase(filename, { readOnly: true });
            try {
              validate(reader, label);
              assertCurrent();
            } finally {
              reader.close();
            }
          }
        : undefined,
    });
  } catch (cause) {
    throw new Error(`SQLite recovery input could not be captured: ${sourcePath}`, { cause });
  } finally {
    cleanupFailed = !frozen.cleanup();
  }
  if (cleanupFailed) {
    throw new Error(`Update recovery source staging could not be closed: ${sourcePath}`);
  }
  if (!assertSnapshot) {
    throw new Error("SQLite snapshot did not retain its native content guard.");
  }
  assertSnapshot();
  return assertSnapshot;
}
