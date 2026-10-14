import path from "node:path";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { readSqliteDatabaseWriteTokenForPath } from "../../infra/sqlite-database-admission.js";
import { readSqliteNativeMutationRevision } from "../../infra/sqlite-schema-facts.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseGenerationClaim } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { runOpenClawAgentWriteAdmissions } from "../../state/openclaw-agent-write-admission.js";
import type { SessionAccessScope, SessionEntryTargetPatchScope } from "./session-accessor.types.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { assertSessionEntryCohortScope } from "./session-entry-cohort-scope.js";
import { SessionEntryChangedDuringReadError } from "./session-entry-read-errors.js";
import {
  readSessionEntriesWithRetainedFacts,
  readRetainedSessionEntryFacts,
  retainSessionEntryReadFacts,
} from "./session-entry-read-facts.js";
import { captureSessionEntryWorkerRequest } from "./session-entry-read-request.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryWorkerRead,
  SessionEntryCohortReader,
} from "./session-entry-read-runtime.types.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import { targetDiscoveryLane } from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";
import { createSessionWorkerExecutionSource } from "./session-worker-execution-source.js";

type ReadSessionStore = <T>(
  input: SessionEntryWorkerRead,
  consume: (source: {
    reader: SessionHistoryWorkerDatabase;
    database: PreparedSessionEntryWorkerRead["database"];
    continuation?: CanonicalSessionReaderContinuation;
    assertCurrent: () => void;
  }) => Promise<T>,
) => Promise<T>;

/** Data-only return; decisions/effects consume withRead's synchronous callback directly. */
export async function readAdmittedSessionEntry(
  reader: SessionEntryCohortReader,
  input: SessionAccessScope,
  assertCurrent: () => void,
  onReadTarget?: (target: SessionEntryTargetPatchScope) => void,
) {
  assertCurrent();
  const key = assertSessionEntryCohortScope(reader, input);
  const read = await reader.readEntry(assertCurrent);
  assertCurrent();
  reader.assertCurrent();
  onReadTarget?.({
    agentId: reader.logicalAgentId,
    env: reader.database.env,
    storePath: read.source.path,
    readSource: { ...read.source },
    target: { canonicalKey: key, storeKeys: [key] },
  });
  return read.entry;
}

/** Admission already owns this execution; the reader neither opens nor promotes storage. */
export function createAdmittedSessionEntryCohortReader(params: {
  execution: OpenClawAgentDatabaseExecution;
  generation: AgentDatabaseGenerationClaim;
  database: PreparedSessionEntryWorkerRead["database"];
  sessionKey: string;
  logicalAgentId: string;
  storePaths: readonly string[];
  expected: NonNullable<SessionEntryCohortRequest["expected"]>;
}): SessionEntryCohortReader {
  const database = Object.freeze({
    ...params.database,
    env: Object.freeze({ ...params.database.env }),
  });
  const expected = structuredClone(params.expected);
  const assertOwnerCurrent = () => {
    params.execution.assertCurrent();
    params.generation.assertCurrent();
  };
  return {
    database,
    sessionKey: params.sessionKey,
    logicalAgentId: params.logicalAgentId,
    storePaths: Object.freeze([
      ...new Set([...params.storePaths, database.path].map((p) => path.resolve(p))),
    ]),
    assertCurrent: assertOwnerCurrent,
    async readEntry(assertCallerCurrent) {
      const assertCurrent = () => {
        assertOwnerCurrent();
        assertCallerCurrent();
      };
      assertCurrent();
      const request = { sessionKeys: [params.sessionKey] };
      const read = await readSessionEntriesWithRetainedFacts(database, request, () =>
        withSessionHistoryWorkerDatabase(
          database,
          (reader) => reader.readExactEntries({ ...request, env: database.env }),
          targetDiscoveryLane,
        ),
      );
      assertCurrent();
      const entry = read.entries.find((row) => row.sessionKey === params.sessionKey)?.entry;
      const admitted = expected.sessions.find(
        (session) => session.sessionKey === params.sessionKey,
      );
      if (
        !entry ||
        !admitted ||
        !read.source ||
        read.source.databaseIdentity !== params.generation.identity ||
        entry.sessionId !== admitted.sessionId ||
        entry.lifecycleRevision !== admitted.lifecycleRevision
      ) {
        throw new SessionEntryChangedDuringReadError();
      }
      return { entry, source: read.source };
    },
    async withRead(request, assertCallerCurrent, consume) {
      assertOwnerCurrent();
      assertCallerCurrent();
      const captured = structuredClone({
        ...request,
        expected,
        transcript: request.transcript && {
          ...request.transcript,
          agentId: params.logicalAgentId,
        },
      });
      let assertNativeCurrent: (() => void) | undefined;
      const assertCurrent = () => {
        if (!assertNativeCurrent) {
          throw new Error("Session cohort consumption has ended");
        }
        assertOwnerCurrent();
        assertCallerCurrent();
        assertNativeCurrent();
      };
      const source = createSessionWorkerExecutionSource(
        assertCurrent,
        "Session cohort authority expired",
      );
      const result = await params.execution.runExisting(
        source,
        async (worker) => {
          const before = readSqliteDatabaseWriteTokenForPath(database.path);
          const cached = readRetainedSessionEntryFacts(database, captured, params.generation);
          const read =
            cached ?? (await worker.execute({ type: "session.entry.read", input: captured }));
          assertCurrent();
          if (!cached) {
            retainSessionEntryReadFacts(database, captured, read, before);
          }
          const value = consume(read, assertCurrent);
          if (isPromiseLike(value)) {
            void Promise.resolve(value).catch(() => {});
            throw new Error("Session cohort consumers must remain synchronous");
          }
          assertCurrent();
          return { value };
        },
        {
          withAdmission: (run, signal) =>
            runOpenClawAgentWriteAdmissions(
              [database],
              async () => {
                assertNativeCurrent = captureSessionEntryNativeMutationWitness([database]);
                try {
                  assertCurrent();
                  return await run();
                } finally {
                  assertNativeCurrent = undefined;
                }
              },
              true,
              signal,
            ),
        },
      );
      if (!result) {
        throw new SessionEntryChangedDuringReadError();
      }
      return result.value;
    },
  };
}

/** Capture under writer FIFO custody; validation grants no access to a released reader. */
export function captureSessionEntryNativeMutationWitness(
  databases: readonly PreparedSessionEntryWorkerRead["database"][],
) {
  const sources = databases.map((database) => {
    const native = getOpenClawAgentDatabaseIfOpen(database);
    return { database, native, revision: native && readSqliteNativeMutationRevision(native.db) };
  });
  return () => {
    for (const { database, native, revision } of sources) {
      if (
        getOpenClawAgentDatabaseIfOpen(database) !== native ||
        (native &&
          (native.db.isTransaction ||
            revision === undefined ||
            readSqliteNativeMutationRevision(native.db) !== revision))
      ) {
        throw new SessionEntryChangedDuringReadError();
      }
    }
  };
}

/** Native effects retain existing writer FIFO order through their synchronous consumer. */
export async function withOrderedSessionEntriesInWorker<T>(
  inputs: readonly SessionEntryWorkerRead[],
  consume: (reads: readonly PreparedSessionEntryWorkerRead[]) => T,
  { readStore, onReadAdmitted }: { readStore: ReadSessionStore; onReadAdmitted?: () => void },
): Promise<T> {
  const selected: Array<{
    input: SessionEntryWorkerRead;
    owner: SessionHistoryWorkerDatabase;
    database: PreparedSessionEntryWorkerRead["database"];
    continuation: CanonicalSessionReaderContinuation | undefined;
    assertCurrent: () => void;
  }> = [];
  const enter = (index: number): Promise<T> => {
    const input = inputs[index];
    if (input) {
      return readStore(input, async ({ reader, database, continuation, assertCurrent }) => {
        selected.push({ input, owner: reader, database, continuation, assertCurrent });
        try {
          return await enter(index + 1);
        } finally {
          selected.pop();
        }
      });
    }
    return runOpenClawAgentWriteAdmissions(
      selected.map(({ database }) => database),
      async () => {
        // Synchronous SDK writers bypass the FIFO and may not publish row changes.
        const assertNativeCurrent = captureSessionEntryNativeMutationWitness(
          selected.map(({ database }) => database),
        );
        let changed = false;
        const unsubscribe = sessionChanges.subscribeFacts((change) => {
          if (!("all" in change) && change.scope === "acp") {
            return;
          }
          const scope = "all" in change ? change.scope : change;
          if (typeof scope === "string") {
            // Registry topology can invalidate discovery; presentation-only buses
            // (placements, activity, profiles) do not change these stored entries.
            changed ||= scope === "stores";
            return;
          }
          if (
            !("all" in change) &&
            !change.factsInvalidated &&
            (!change.facts || change.facts.kind === "unchanged")
          ) {
            return;
          }
          const matching = selected.filter(
            ({ input: selectedInput }) =>
              (!scope.agentId || scope.agentId === selectedInput.agentId) &&
              ("all" in change ||
                !selectedInput.sessionKeys ||
                selectedInput.sessionKeys.includes(change.sessionKey)),
          );
          if (matching.length === 0) {
            return;
          }
          try {
            const physicalPath = scope.storePath
              ? captureSessionStoreReadCandidate(
                  resolveUnsuffixedSqliteTargetFromSessionStorePath(scope.storePath).path,
                ).physicalPath
              : undefined;
            changed ||= matching.some(
              ({ database }) => !physicalPath || physicalPath === database.path,
            );
          } catch {
            changed = true;
          }
        });
        let active = true;
        const assertCurrent = () => {
          if (!active) {
            throw new Error("Session entry read consumer is no longer active");
          }
          for (const read of selected) {
            read.assertCurrent();
          }
          assertNativeCurrent();
          if (changed) {
            throw new SessionEntryChangedDuringReadError();
          }
        };
        try {
          assertCurrent();
          onReadAdmitted?.();
          const reads: PreparedSessionEntryWorkerRead[] = [];
          for (const { input: selectedInput, owner, database, continuation } of selected) {
            assertCurrent();
            const request = captureSessionEntryWorkerRequest(selectedInput);
            const before = readSqliteDatabaseWriteTokenForPath(database.path);
            const cached = readRetainedSessionEntryFacts(database, request);
            const result =
              cached ??
              (await owner.readExactEntries({
                ...request,
                env: database.env,
                continuation,
              }));
            assertCurrent();
            if (!cached) {
              retainSessionEntryReadFacts(database, request, result, before);
            }
            reads.push({ result, database, assertCurrent });
          }
          const result = consume(reads);
          if (isPromiseLike(result)) {
            void Promise.resolve(result).catch(() => {});
            throw new Error("Session entry read consumers must remain synchronous");
          }
          return result;
        } finally {
          active = false;
          unsubscribe();
        }
      },
      true,
    );
  };
  return enter(0);
}
