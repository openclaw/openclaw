import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { runOpenClawAgentWriteAdmissions } from "../../state/openclaw-agent-write-admission.js";
import type { CanonicalSessionReaderContinuation } from "./session-canonical-key.js";
import { captureSessionEntryWorkerRequest } from "./session-entry-read-request.js";
import type {
  PreparedSessionEntryWorkerRead,
  SessionEntryWorkerRead,
} from "./session-entry-read-runtime.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import { captureSessionStoreReadCandidate } from "./session-store-read-candidates.js";
import type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

type ReadSessionStore = <T>(
  input: SessionEntryWorkerRead,
  consume: (source: {
    reader: SessionHistoryWorkerDatabase;
    database: PreparedSessionEntryWorkerRead["database"];
    continuation?: CanonicalSessionReaderContinuation;
    assertCurrent: () => void;
  }) => Promise<T>,
) => Promise<T>;

/** Native effects retain existing writer FIFO order through their synchronous consumer. */
export async function withOrderedSessionEntriesInWorker<T>(
  inputs: readonly SessionEntryWorkerRead[],
  consume: (reads: readonly PreparedSessionEntryWorkerRead[]) => T,
  readStore: ReadSessionStore,
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
        let changed = false;
        const unsubscribe = sessionChanges.subscribeFacts((change) => {
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
          if (changed) {
            throw new Error("Session entry changed during read");
          }
        };
        try {
          const reads: PreparedSessionEntryWorkerRead[] = [];
          for (const { input: selectedInput, owner, database, continuation } of selected) {
            assertCurrent();
            const result = await owner.readExactEntries({
              ...captureSessionEntryWorkerRequest(selectedInput),
              env: database.env,
              continuation,
            });
            assertCurrent();
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
    );
  };
  return enter(0);
}
