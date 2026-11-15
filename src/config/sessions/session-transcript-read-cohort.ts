import {
  getSqliteDatabaseAdmissionSourceForPath,
  prepareSqliteDatabaseAdmissionAsync,
  readSqliteDatabaseScopedWriteTokenForPath as readWriteToken,
  sqliteSessionIdWriteScope,
} from "../../infra/sqlite-database-admission.js";
import type {
  DatabaseFileIdentity,
  DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import { runOpenClawAgentPreparedWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import { captureSessionEntryNativeMutationWitness } from "./session-entry-read-ordered.js";
import type { PreparedSessionEntryWorkerRead } from "./session-entry-read-runtime.types.js";
import { collectSessionEntryLookupKeys } from "./store-entry.js";

/** Read without reserving the writer; accept only an unchanged snapshot under FIFO custody. */
export async function readSessionTranscriptCohort<T, R>(
  database: PreparedSessionEntryWorkerRead["database"] & {
    expectedIdentity?: DatabaseFileIdentity;
  },
  scope: Pick<SessionTranscriptReadScope, "sessionId" | "sessionKey">,
  read: () => Promise<T>,
  consume: (value: T) => R,
  assertCurrent: () => void,
  signal: AbortSignal | undefined,
  caller: "history.hydration" | "history.model-context",
): Promise<R> {
  const writeScopes = [
    ...(scope.sessionKey ? collectSessionEntryLookupKeys(scope.sessionKey) : []),
    sqliteSessionIdWriteScope(scope.sessionId),
  ];
  const assertActive = () => {
    signal?.throwIfAborted();
    assertCurrent();
  };
  const prepare = async () => {
    const source = getSqliteDatabaseAdmissionSourceForPath(database.path);
    const prepared = await prepareSqliteDatabaseAdmissionAsync({
      location: database.path,
      identity: source && { ...source.identity, canonicalPath: source.canonicalPath },
      expectedIdentity: database.expectedIdentity,
      assertCurrent: assertActive,
    });
    if (!prepared) {
      throw new SessionEntryChangedDuringReadError();
    }
    return prepared;
  };
  const admitted = <V>(run: (identity: DatabasePathIdentity, assertOwner: () => void) => V) =>
    runOpenClawAgentPreparedWriteAdmission(
      async () => ({
        options: database,
        identity: await prepare(),
      }),
      async (_source, identity, assertOwner) => {
        assertActive();
        assertOwner();
        const value = await run(identity, assertOwner);
        assertOwner();
        assertActive();
        return value;
      },
      true,
      { signal, caller },
    );
  const captureMutationWitness = (identity: DatabasePathIdentity) => {
    const token = readWriteToken(database.path, writeScopes, identity);
    const assertNative = captureSessionEntryNativeMutationWitness([database]);
    return (currentIdentity: DatabasePathIdentity) => {
      if (readWriteToken(database.path, writeScopes, currentIdentity) !== token) {
        throw new SessionEntryChangedDuringReadError();
      }
      assertNative();
    };
  };
  // Keep ordinary reads outside FIFO custody. Repeated contention gets one
  // serialized read so concurrent session starts cannot exhaust the retry.
  for (let attempt = 0; ; attempt++) {
    const assertUnchanged = await admitted((identity) => {
      assertCurrent();
      return captureMutationWitness(identity);
    });
    const value = await read();
    const result = await admitted(async (identity, assertOwner) => {
      signal?.throwIfAborted();
      assertCurrent();
      let current = value;
      let assertSnapshot = assertUnchanged;
      try {
        assertSnapshot(identity);
      } catch (error) {
        if (!(error instanceof SessionEntryChangedDuringReadError)) {
          throw error;
        }
        if (attempt === 0) {
          return { retry: true } as const;
        }
        assertSnapshot = captureMutationWitness(identity);
        current = await read();
        assertOwner();
        assertCurrent();
        assertSnapshot(identity);
      }
      const consumed = consume(current);
      assertCurrent();
      assertSnapshot(identity);
      return { retry: false, value: consumed } as const;
    });
    if (!result.retry) {
      return result.value;
    }
  }
}
