import type { AsyncPreparedSqliteReadOnlyLocation } from "../../infra/sqlite-readonly-location.types.js";
import { prepareSqliteReadOnlyLocationAwaited } from "../../infra/sqlite-snapshot-source.js";
import {
  assertExistingDatabaseIdentity,
  type DatabaseFileIdentity,
} from "../../infra/sqlite-worker-identity.js";
import type { SessionExactEntriesWorkerInput } from "./session-entry-read.types.js";

type SessionEntryInspectionSnapshot = AsyncPreparedSqliteReadOnlyLocation & {
  assertCurrent?: () => void;
};

/** The enclosing inspection owns borrowed bytes through worker settlement and cleanup. */
export function prepareSessionEntryInspectionSnapshot(
  request: Pick<SessionExactEntriesWorkerInput, "database" | "inspectionSnapshot">,
  signal: AbortSignal,
  expectedSourceIdentity: DatabaseFileIdentity,
): SessionEntryInspectionSnapshot | Promise<SessionEntryInspectionSnapshot> {
  const snapshot = request.inspectionSnapshot;
  if (snapshot) {
    return {
      location: snapshot.canonicalPath,
      assertCurrent: () =>
        assertExistingDatabaseIdentity(snapshot.canonicalPath, snapshot.key, snapshot.birthtime),
      cleanupAsync: async () => true,
    };
  }
  return prepareSqliteReadOnlyLocationAwaited(request.database.path, {
    signal,
    expectedSourceIdentity,
  });
}
