import {
  captureNativeSessionWorkerDeletion,
  hasPreparedNativeSessionDeletion,
  withSqliteSessionDeletions,
} from "./session-accessor.sqlite-deletion.js";
import {
  runExclusiveSqliteSessionWrite,
  type ResolvedSqliteReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import type { SessionEntryCreateWithTranscriptOptions } from "./session-accessor.types.js";

type PreparedSessionWrite<T> = {
  deletedEntries: Parameters<typeof withSqliteSessionDeletions>[1];
  beforeCommit?: () => Promise<void>;
  commit: (assertSourceCurrent?: () => void) => T | Promise<T>;
};

/** Keep ordinary updates serialized; release the writer for preparation or source custody. */
export async function runPreparedSqliteSessionWrite<T>(
  initialScope: ResolvedSqliteReadScope,
  prepare: (scope: ResolvedSqliteReadScope) => Promise<PreparedSessionWrite<T>>,
  operation: SqliteSessionWriteOperation,
  withCommit?: SessionEntryCreateWithTranscriptOptions["withCommit"],
  prepareScope?: () => Promise<ResolvedSqliteReadScope>,
  scheduling: "foreground" | "worker" = "foreground",
): Promise<{ deletedEntries: number; result: Awaited<T>; scope: ResolvedSqliteReadScope }> {
  let scope = initialScope;
  const prepareWrite = async () => {
    if (prepareScope) {
      const preparedScope = await prepareScope();
      if (preparedScope.path !== scope.path) {
        throw new Error("Session write preparation changed its reserved database path");
      }
      scope = preparedScope;
    }
    const write = await prepare(scope);
    return scheduling === "worker" ||
      write.deletedEntries.length ||
      write.beforeCommit ||
      withCommit
      ? { write }
      : { result: await write.commit() };
  };
  // Worker phases acquire this same queue themselves; an outer foreground permit
  // would make their read admission wait behind its own preparation.
  const prepared =
    scheduling === "worker"
      ? await prepareWrite()
      : await runExclusiveSqliteSessionWrite(scope, prepareWrite, operation);
  if (!prepared.write) {
    return { deletedEntries: 0, result: prepared.result, scope };
  }
  const write = prepared.write;
  const commit = async (assertCurrent?: () => void) => {
    await write.beforeCommit?.();
    const runCommit = async (assertSourceCurrent?: () => void) => {
      const commitHeld = async () => {
        const assertHeld = () => {
          assertCurrent?.();
          assertSourceCurrent?.();
        };
        assertHeld();
        return await write.commit(assertHeld);
      };
      // Opaque native mutations stay on their original writer and ALS owner.
      return scheduling === "worker" &&
        (!hasPreparedNativeSessionDeletion() ||
          captureNativeSessionWorkerDeletion(write.deletedEntries))
        ? await commitHeld()
        : await runExclusiveSqliteSessionWrite(scope, commitHeld, operation);
    };
    return withCommit ? await withCommit(runCommit) : await runCommit();
  };
  const result =
    write.deletedEntries.length || write.beforeCommit
      ? await withSqliteSessionDeletions(scope, write.deletedEntries, commit)
      : await commit();
  return { deletedEntries: write.deletedEntries.length, result, scope };
}
