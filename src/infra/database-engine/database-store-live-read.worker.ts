import { hasVerifiedLiveSqliteOwner } from "../sqlite-live-owner.js";
import { tryInspectSqliteReadOnlyInProcess } from "../sqlite-readonly-inspection.js";
import {
  readSourceJournalMode,
  readSourceSidecars,
  SqliteSourceChangedError,
} from "../sqlite-readonly-location.js";
import type { SqliteReadOnlyOperationExecutionContext } from "../sqlite-readonly-operation-types.js";
import type { DatabaseStoreLiveReadOperations } from "./database-store-live-read.worker-contract.js";
import { inspectSqliteStoreImage } from "./sqlite-store-inspection.js";

function isLiveWalSource(pathname: string): boolean {
  try {
    const sidecars = readSourceSidecars(pathname);
    // Rollback readers would hold a SHARED lock against the writer's commit, and a WAL
    // without its index needs recovery; both keep today's private copy.
    return readSourceJournalMode(pathname) === "wal" && sidecars.wal && sidecars.shm;
  } catch (error) {
    if (error instanceof SqliteSourceChangedError) {
      return false;
    }
    throw error;
  }
}

type LiveRead = DatabaseStoreLiveReadOperations["databaseStore.inspectLive"];

export const databaseStoreLiveReadOperations = {
  /** Descriptor-free inspection only: the host keeps descriptor checks on its private copy. */
  "databaseStore.inspectLive": (
    input: LiveRead["input"],
    context: SqliteReadOnlyOperationExecutionContext,
  ): LiveRead["output"] => {
    context.assertCurrent();
    // Only a verified live owner proves its WAL index is current; this reader never rebuilds it.
    if (!isLiveWalSource(context.path) || !hasVerifiedLiveSqliteOwner(context.path)) {
      return undefined;
    }
    const read = tryInspectSqliteReadOnlyInProcess(context.path, (db) => {
      const { diagnostic } = input;
      return { diagnostic, engine: inspectSqliteStoreImage(diagnostic, db, context.path) };
    });
    context.assertCurrent();
    return read?.value;
  },
};
