import {
  createSqliteLifecycleAggregateError,
  throwSqliteLifecycleErrors,
} from "../../infra/sqlite-lifecycle-errors.js";
import { runSqliteReadOperationSync } from "../../infra/sqlite-schema-facts.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabaseHandle,
} from "../../state/openclaw-agent-db-readonly-open.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import type { SessionColdLockedGuard } from "./session-cold-storage-guard.types.js";
import type { SessionSourcePredicate } from "./session-source-authority.js";
import { readRefusedSessionSource } from "./session-source-predicate.worker.js";
import type { TranscriptAppendRefusal } from "./session-transcript-writer-claim-error.js";
import type { InternalSessionEntry } from "./types.js";

type SourceRefusal = NonNullable<ReturnType<typeof readRefusedSessionSource>>;

export class SessionColdSourceRefusedError extends Error {
  constructor(readonly refusal: SourceRefusal) {
    super("Session source changed before cold transcript restoration");
  }
}

/** Admit foreign readers before taking the restoration writer, never across a read snapshot. */
export function prepareSessionColdSourceGuard(
  target: OpenClawAgentDatabaseOptions & { path: string },
  sources: readonly SessionSourcePredicate[] = [],
) {
  const targetIdentity = sources.some(({ source }) => source.path !== target.path)
    ? readDatabasePathIdentitySync(target.path).key
    : undefined;
  const isForeign = ({ source }: SessionSourcePredicate) =>
    source.path !== target.path && `file:${String(source.databaseIdentity)}` !== targetIdentity;
  const readers = new Map<string, OpenClawAgentReadOnlyDatabaseHandle | undefined>();
  const close = () => {
    const errors: unknown[] = [];
    for (const reader of readers.values()) {
      try {
        reader?.close();
      } catch (error) {
        errors.push(error);
      }
    }
    throwSqliteLifecycleErrors(errors, "Cold transcript source readers failed to close");
  };
  try {
    for (const predicate of sources.filter(isForeign)) {
      const { source } = predicate;
      const key = String(source.databaseIdentity);
      if (!readers.has(key)) {
        const opened = openOpenClawAgentDatabaseReadOnly({
          agentId: source.agentId,
          path: source.path,
          env: target.env,
        });
        readers.set(key, opened.found ? opened.database : undefined);
      }
    }
  } catch (error) {
    try {
      close();
    } catch (cleanupError) {
      throw createSqliteLifecycleAggregateError(
        [error, cleanupError],
        "Cold source preparation failed",
        error,
      );
    }
    throw error;
  }
  const read = (
    database?: Parameters<typeof readRefusedSessionSource>[0],
    entries?: ReadonlyMap<string, InternalSessionEntry | undefined>,
  ): SourceRefusal | undefined => {
    for (const [index, predicate] of sources.entries()) {
      const foreign = isForeign(predicate);
      const foreignReader = readers.get(String(predicate.source.databaseIdentity));
      const expected = {
        key: `file:${String(predicate.source.databaseIdentity)}`,
        birthtime: predicate.source.databaseBirthtime,
      };
      try {
        assertExistingDatabaseIdentity(predicate.source.path, expected.key, expected.birthtime);
        if (foreign && foreignReader) {
          assertOpenClawAgentDatabaseIdentity(foreignReader, expected);
        }
      } catch {
        return { index, facts: { entry: undefined } };
      }
      if (!foreign && !database) {
        continue;
      }
      const reader = foreign ? foreignReader : database;
      if (!reader || reader.agentId !== predicate.source.agentId) {
        return { index, facts: { entry: undefined } };
      }
      const readPredicate = () =>
        readRefusedSessionSource(reader, [predicate], undefined, foreign ? undefined : entries);
      const refused = foreign
        ? runSqliteDeferredTransactionSync(reader.db, () =>
            runSqliteReadOperationSync(reader.db, readPredicate, "fresh"),
          )
        : readPredicate();
      if (refused) {
        return { ...refused, index };
      }
    }
    return undefined;
  };
  return {
    read,
    assertForeign() {
      const refused = read();
      if (refused) {
        throw new SessionColdSourceRefusedError(refused);
      }
    },
    [Symbol.dispose]: close,
  };
}

/** Keep the write-owner predicate out of the shared read worker's import closure. */
export function readSessionColdLockedRefusal(
  params: {
    database: OpenClawAgentDatabase;
    sessionId: string;
    guard: SessionColdLockedGuard;
    sourceGuard: ReturnType<typeof prepareSessionColdSourceGuard> | undefined;
  },
  resolveWriterRefusal: typeof resolveTranscriptAppendRefusal,
): { refusedSource: SourceRefusal } | { writerRefusal: TranscriptAppendRefusal } | undefined {
  const { database, sessionId, guard, sourceGuard } = params;
  const { agentId, sessionKey, fence, sources } = guard;
  const fenced =
    fence.expectedOwner !== undefined ||
    fence.expectedLifecycleRevision !== undefined ||
    fence.expectedWriterRunId !== undefined;
  // Unfenced locks can read historical or orphaned windows without a current entry.
  const entry = fenced ? readSessionEntryRow(database, sessionKey)?.entry : undefined;
  const entries = fenced ? new Map([[sessionKey, entry]]) : undefined;
  const refusedSource = sourceGuard
    ? sourceGuard.read(database, entries)
    : readRefusedSessionSource(database, sources, undefined, entries);
  if (refusedSource) {
    return { refusedSource };
  }
  if (fenced) {
    const target = { agentId, sessionKey, sessionId };
    const refusal = resolveWriterRefusal(entry, target, { ...target, ...fence });
    if (refusal) {
      return { writerRefusal: refusal };
    }
  }
  return undefined;
}
