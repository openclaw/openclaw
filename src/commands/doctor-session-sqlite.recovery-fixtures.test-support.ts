import { readMigrationArtifactIdentity } from "../infra/session-sqlite-migration-artifact.js";
import type { SessionSqliteMigrationMove } from "../infra/session-sqlite-migration-manifest.js";

export function retainedHistoryMove(
  sourcePath: string,
  archivePath: string,
): SessionSqliteMigrationMove {
  return {
    kind: "unreferenced-jsonl",
    sourcePath,
    archivePath,
    artifact: {
      identity: readMigrationArtifactIdentity(archivePath),
      classification: "protected",
      reason: "unreferenced-history",
      dependencies: [],
      disposal: { state: "retained" },
    },
  };
}
