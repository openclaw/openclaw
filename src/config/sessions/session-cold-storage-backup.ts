import type { DatabaseSync } from "node:sqlite";
import type { SqliteArchiveOneShotWorkerData } from "./session-accessor.sqlite-archive-types.js";

/** The caller retains its private snapshot until embedding joins, before compaction/publication. */
export async function embedSessionColdArchivesInSnapshot(params: {
  database: DatabaseSync;
  sourceStorePath: string;
}): Promise<void> {
  const snapshotPath = params.database.location();
  if (!snapshotPath) {
    throw new Error("Cold archive embedding requires a file-backed private snapshot");
  }
  const { runSqliteTranscriptArchiveWorkerOperation } =
    await import("./session-accessor.sqlite-archive.js");
  await runSqliteTranscriptArchiveWorkerOperation<void>({
    expectedMessageType: "done",
    nativeLocations: [snapshotPath],
    workerData: {
      type: "sqlite-transcript-archive-v2",
      operation: "cold-embed-snapshot",
      snapshotPath,
      sourceStorePath: params.sourceStorePath,
    } satisfies SqliteArchiveOneShotWorkerData,
  });
}
