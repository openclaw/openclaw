import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  assertAgentDatabaseTerminalOpenAllowed,
  revalidateAgentDatabaseTerminalOpenAsync,
} from "../../state/openclaw-agent-db-terminal.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import type { SessionActorMemoryHistoryReads } from "./session-actor-memory-history-contract.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";
import type { SessionTranscriptMaintenanceRead } from "./session-transcript-hydration.types.js";
import { resolveSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";
import {
  targetDiscoveryLane,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "./session-transcript-worker-runtime.js";
import type {
  PreparedSessionTranscriptHydration,
  SessionHistoryWorkerDatabase,
  SessionTranscriptCurrentTurnEntryRead,
  SessionTranscriptCurrentTurnEntryRequest,
} from "./session-transcript-worker.types.js";
import {
  captureSessionTranscriptTargetBinding,
  type CapturedSessionTranscriptTargetBinding,
} from "./transcript-target-binding.js";
import { readOwnedSessionTranscriptEntry } from "./transcript-write-context.js";

type SessionTranscriptHydrationReader = {
  target: CapturedSessionTranscriptTargetBinding;
  assertCurrent: () => void;
  read: () => Promise<PreparedSessionTranscriptHydration>;
  readCohort?: (
    selection: NonNullable<SessionEntryCohortRequest["transcript"]>,
    consume: (prepared: PreparedSessionTranscriptHydration) => void,
  ) => Promise<void>;
  readCurrentTurnEntry: (
    request: SessionTranscriptCurrentTurnEntryRequest,
  ) => Promise<SessionTranscriptCurrentTurnEntryRead>;
  readMaintenance: (
    request: SessionTranscriptMaintenanceRead,
  ) => Promise<SessionActorMemoryHistoryReads["session.history.maintenance"]["output"]>;
  readRecentActiveEvents: (
    maxEvents: number,
  ) => Promise<SessionActorMemoryHistoryReads["session.history.recent-active-events"]["output"]>;
  readLatestActiveMessage: () => Promise<
    SessionActorMemoryHistoryReads["session.history.latest-active-message"]["output"]
  >;
};

/** Capture identity before queueing; a missing file remains the creation owner's responsibility. */
export function prepareSessionTranscriptHydration(
  source: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv },
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
  lane?: SessionHistoryWorkerLane,
): SessionTranscriptHydrationReader {
  const memory = captureSessionActorTranscriptRead(source, signal);
  if (memory) {
    const version = () => ({ generation: null, rawSeq: null, updatedAt: null });
    return {
      target: memory.target,
      assertCurrent: memory.assertCurrent,
      read: async () => {
        if (!memory.missing) {
          return memory.read("session.history.hydrate", { limits });
        }
        memory.assertCurrent();
        return limits
          ? {
              kind: "bounded",
              snapshot: {
                activeLeafEntryId: null,
                version: version(),
                events: [],
                opaqueParents: new Map(),
                parents: new Map(),
                firstKeptRanges: new Map(),
                persistedSuffixStartSeq: 0,
                boundaryCount: 0,
                serializedBytes: 0,
                totalEvents: 0,
                transcriptMutationAt: null,
                truncated: false,
                completeActivePath: true,
              },
            }
          : {
              kind: "full",
              snapshot: { events: [], eventJson: [], eventSeqs: [], version: version() },
            };
      },
      readCurrentTurnEntry: async (request) => {
        if (!memory.missing) {
          return memory.read("session.history.current-turn-entry", request);
        }
        memory.assertCurrent();
        return { kind: "current-turn-entry", version: version() };
      },
      readMaintenance: async (request) => {
        if (!memory.missing) {
          return memory.read("session.history.maintenance", { request });
        }
        memory.assertCurrent();
        return { kind: "transcript-maintenance" };
      },
      readRecentActiveEvents: async (maxEvents) => {
        if (!memory.missing) {
          return memory.read("session.history.recent-active-events", { maxEvents });
        }
        memory.assertCurrent();
        return [];
      },
      readLatestActiveMessage: async () => {
        if (!memory.missing) {
          return memory.read("session.history.latest-active-message", {});
        }
        memory.assertCurrent();
        return undefined;
      },
    };
  }
  const target = captureSessionTranscriptTargetBinding(source);
  const contextLimits = limits
    ? { maxBytes: limits.maxBytes, maxEvents: limits.maxEvents }
    : undefined;
  const receipt = resolveSessionTranscriptReadFence(target);
  const admission = receipt ? { ...receipt } : undefined;
  signal?.throwIfAborted();
  const readInOwner = async <T>(
    readInWorker: (
      owner: SessionHistoryWorkerDatabase,
      resolvedScope: ResolvedTranscriptReadScope,
    ) => Promise<T>,
  ): Promise<T> => {
    signal?.throwIfAborted();
    const resolvedScope = await prepareSqliteTranscriptReadScope(target, signal);
    signal?.throwIfAborted();
    const options = toDatabaseOptions(resolvedScope);
    const databasePath = resolveOpenClawAgentSqlitePath(options);
    await revalidateAgentDatabaseTerminalOpenAsync(
      databasePath,
      () => signal?.throwIfAborted(),
      signal,
    );
    try {
      const result = await withSessionHistoryWorkerDatabase(
        options,
        async (owner) => {
          const assertReadCurrent = () => {
            signal?.throwIfAborted();
            owner.assertCurrent();
          };
          try {
            return await readRestoredSessionTranscript(
              target,
              () => readInWorker(owner, resolvedScope),
              {
                assertCurrent: assertReadCurrent,
                coldRead: {
                  target: resolvedScope,
                  readMetadata: async () => {
                    const metadata = await owner.readColdMetadata({
                      sessionId: resolvedScope.sessionId,
                      env: target.env,
                    });
                    return metadata.archive;
                  },
                },
              },
            );
          } finally {
            // An absent-store reply must not hide a revoked read owner.
            owner.assertCurrent();
          }
        },
        lane,
      );
      signal?.throwIfAborted();
      return result;
    } finally {
      assertAgentDatabaseTerminalOpenAllowed(databasePath);
    }
  };
  const read = (): Promise<PreparedSessionTranscriptHydration> =>
    readInOwner<PreparedSessionTranscriptHydration>((owner, resolvedScope) =>
      owner.readTranscript({ target, resolvedScope, limits: contextLimits, admission }, signal),
    );
  const readCohort: SessionTranscriptHydrationReader["readCohort"] = contextLimits
    ? (selection, consume) => {
        const capturedSelection = structuredClone(selection);
        return withSessionTranscriptReadSource(
          target,
          async ({ scope, resolved, owner, expectedIdentity, assertCurrent: assertSource }) => {
            const { captureSessionEntryNativeMutationWitness } =
              await import("./session-entry-read-ordered.js");
            assertSource();
            const database = {
              agentId: resolved.databaseAgentId ?? resolved.agentId,
              path: scope.storePath,
              env: scope.env,
            };
            // Restoration needs the writer too; leave FIFO before handling a cold miss.
            await readRestoredSessionTranscript(
              scope,
              () =>
                runOpenClawAgentWriteAdmission(
                  database,
                  async (_identity, assertOwner) => {
                    assertSource();
                    const assertNative = captureSessionEntryNativeMutationWitness([database]);
                    const prepared = await owner.readTranscript(
                      {
                        target: scope,
                        resolvedScope: resolved,
                        expectedIdentity,
                        limits: contextLimits,
                        admission,
                        transcript: capturedSelection,
                        preparedEntry: readOwnedSessionTranscriptEntry(target),
                      },
                      signal,
                    );
                    signal?.throwIfAborted();
                    assertOwner();
                    assertSource();
                    assertNative();
                    const consumed = consume(prepared);
                    if (isPromiseLike(consumed)) {
                      void Promise.resolve(consumed).catch(() => {});
                      throw new Error("Transcript cohort consumers must remain synchronous");
                    }
                    assertSource();
                    assertNative();
                  },
                  true,
                  undefined,
                  signal,
                ),
              {
                assertCurrent: assertSource,
                coldRead: {
                  target: resolved,
                  readMetadata: async () => {
                    const metadata = await owner.readColdMetadata({
                      sessionId: resolved.sessionId,
                      env: scope.env,
                    });
                    return metadata.archive;
                  },
                },
              },
            );
          },
          signal,
          // Cohort consumption holds the writer through read failure and reader cleanup.
          targetDiscoveryLane,
        );
      }
    : undefined;
  const readCurrentTurnEntry = (
    input: SessionTranscriptCurrentTurnEntryRequest,
  ): Promise<SessionTranscriptCurrentTurnEntryRead> => {
    const request = {
      entryId: input.entryId,
      version: { ...input.version },
      includeEntry: input.includeEntry,
    };
    return readInOwner((owner, resolvedScope) =>
      owner.readCurrentTurnEntry({ ...request, target, resolvedScope, admission }, signal),
    );
  };
  const readMaintenance = (request: SessionTranscriptMaintenanceRead) =>
    readInOwner((owner, resolvedScope) =>
      owner.readMaintenance({ target, resolvedScope, admission, request }, signal),
    );
  const readRecentActiveEvents = (maxEvents: number) =>
    readInOwner((owner, resolvedScope) =>
      owner.readRecentActiveEvents({ target, resolvedScope, maxEvents, admission }, signal),
    );
  const readLatestActiveMessage = () =>
    readInOwner((owner, resolvedScope) =>
      owner.readLatestActiveMessage({ target, resolvedScope, admission }, signal),
    );
  return {
    target,
    read,
    readCohort,
    readCurrentTurnEntry,
    readMaintenance,
    readRecentActiveEvents,
    readLatestActiveMessage,
    assertCurrent: () => signal?.throwIfAborted(),
  };
}
