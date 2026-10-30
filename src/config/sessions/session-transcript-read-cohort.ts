import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import { captureSessionEntryNativeMutationWitness } from "./session-entry-read-ordered.js";
import type { PreparedSessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";

/** Read without reserving the writer; accept only an unchanged snapshot under FIFO custody. */
export async function readSessionTranscriptCohort<T, R>(
  database: PreparedSessionEntryWorkerRead["database"],
  read: () => Promise<T>,
  consume: (value: T) => R,
  assertCurrent: () => void,
  signal: AbortSignal | undefined,
  caller: "history.hydration" | "history.model-context",
): Promise<R> {
  const admitted = <V>(run: () => V) =>
    runOpenClawAgentWriteAdmission(
      database,
      (_identity, assertOwner) => {
        assertOwner();
        const value = run();
        assertOwner();
        return value;
      },
      true,
      undefined,
      signal,
      caller,
    );
  // A single retry tolerates a writer overtaking the read, without starving writes
  // or repeating a consumer that may already have produced effects.
  for (let attempt = 0; ; attempt++) {
    const assertUnchanged = await admitted(() => {
      assertCurrent();
      const token = readSqliteDatabaseWriteTokenForPath(database.path);
      const assertNative = captureSessionEntryNativeMutationWitness([database]);
      return () => {
        if (readSqliteDatabaseWriteTokenForPath(database.path) !== token) {
          throw new SessionEntryChangedDuringReadError();
        }
        assertNative();
      };
    });
    const value = await read();
    const result = await admitted(() => {
      signal?.throwIfAborted();
      assertCurrent();
      try {
        assertUnchanged();
      } catch (error) {
        if (attempt === 0 && error instanceof SessionEntryChangedDuringReadError) {
          return { retry: true } as const;
        }
        throw error;
      }
      const consumed = consume(value);
      assertCurrent();
      assertUnchanged();
      return { retry: false, value: consumed } as const;
    });
    if (!result.retry) {
      return result.value;
    }
  }
}
