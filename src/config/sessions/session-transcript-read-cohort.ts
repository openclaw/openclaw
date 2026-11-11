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
  const admitted = <V>(run: (assertOwner: () => void) => V) =>
    runOpenClawAgentWriteAdmission(
      database,
      async (_identity, assertOwner) => {
        assertOwner();
        const value = await run(assertOwner);
        assertOwner();
        return value;
      },
      true,
      undefined,
      signal,
      caller,
    );
  const captureMutationWitness = () => {
    const token = readSqliteDatabaseWriteTokenForPath(database.path);
    const assertNative = captureSessionEntryNativeMutationWitness([database]);
    return () => {
      if (readSqliteDatabaseWriteTokenForPath(database.path) !== token) {
        throw new SessionEntryChangedDuringReadError();
      }
      assertNative();
    };
  };
  // Keep ordinary reads outside FIFO custody. Repeated contention gets one
  // serialized read so concurrent session starts cannot exhaust the retry.
  for (let attempt = 0; ; attempt++) {
    const assertUnchanged = await admitted(() => {
      assertCurrent();
      return captureMutationWitness();
    });
    const value = await read();
    const result = await admitted(async (assertOwner) => {
      signal?.throwIfAborted();
      assertCurrent();
      let current = value;
      let assertSnapshot = assertUnchanged;
      try {
        assertSnapshot();
      } catch (error) {
        if (!(error instanceof SessionEntryChangedDuringReadError)) {
          throw error;
        }
        if (attempt === 0) {
          return { retry: true } as const;
        }
        assertSnapshot = captureMutationWitness();
        current = await read();
        assertOwner();
        assertCurrent();
        assertSnapshot();
      }
      const consumed = consume(current);
      assertCurrent();
      assertSnapshot();
      return { retry: false, value: consumed } as const;
    });
    if (!result.retry) {
      return result.value;
    }
  }
}
