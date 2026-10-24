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
import {
  readSessionActorTranscriptReplica,
  retainSessionActorTranscriptReplica,
} from "./session-actor-replica.js";
import { readSessionActorTranscriptAnchors } from "./session-actor-transcript-anchors.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import {
  readSessionActorTranscriptContext,
  seedSessionActorTranscriptContext,
} from "./session-actor-transcript-replica.js";
import { readRestoredSessionTranscriptInWorker } from "./session-cold-storage-read.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";
import type { SessionTranscriptContextSelection } from "./session-history-read.types.js";
import type { SessionTranscriptMaintenanceRead } from "./session-transcript-hydration.types.js";
import {
  resolveSessionTranscriptReadFence,
  resolveSqliteSessionTranscriptReadFence,
  runWithSessionTranscriptReadFence,
} from "./session-transcript-read-fence.js";
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
import {
  readOwnedSessionTranscriptEntry,
  readOwnedSessionTranscriptState,
} from "./transcript-write-context.js";

type SessionTranscriptHydrationReader = {
  target: CapturedSessionTranscriptTargetBinding;
  assertCurrent: () => void;
  read: (options?: { compaction?: true }) => Promise<PreparedSessionTranscriptHydration>;
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
  limits?: SessionTranscriptContextSelection,
  signal?: AbortSignal,
  lane?: SessionHistoryWorkerLane,
): SessionTranscriptHydrationReader {
  const memory = captureSessionActorTranscriptRead(source, signal);
  if (memory) {
    const version = () => ({ generation: null, rawSeq: null, updatedAt: null });
    return {
      target: memory.target,
      assertCurrent: memory.assertCurrent,
      read: async (options) => {
        if (!memory.missing) {
          const prepared = await memory.read("session.history.hydrate", { limits });
          if (options?.compaction && prepared.kind === "bounded") {
            const { resolveCurrentSessionPrimaryConversation } =
              await import("./conversation-registry.js");
            const entry = memory.currentEntry();
            prepared.compaction = {
              sessionTarget: memory.target,
              entry,
              runtimeEntry: entry,
              primaryConversation: await resolveCurrentSessionPrimaryConversation(memory.target),
            };
          }
          return prepared;
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
              ...(options?.compaction
                ? {
                    compaction: {
                      sessionTarget: memory.target,
                      entry: undefined,
                      runtimeEntry: undefined,
                      primaryConversation: undefined,
                    },
                  }
                : {}),
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
        return {
          kind: "transcript-maintenance",
          ...(request.operation === "custom-branch" && request.leafEntryId === null
            ? { events: [] }
            : {}),
        };
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
  const contextLimits = limits ? { ...limits } : undefined;
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
            return await readRestoredSessionTranscriptInWorker(
              { scope: target, resolved: resolvedScope, owner, assertCurrent: assertReadCurrent },
              () => readInWorker(owner, resolvedScope),
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
  const retainedRead = (selection?: NonNullable<SessionEntryCohortRequest["transcript"]>) => {
    if (!contextLimits || "compaction" in contextLimits) {
      return undefined;
    }
    const hot = readOwnedSessionTranscriptState(target);
    if (!hot) {
      return undefined;
    }
    const retained = readSessionActorTranscriptReplica(hot);
    const prepared = readSessionActorTranscriptContext(retained, hot, contextLimits, admission);
    if (!prepared) {
      return undefined;
    }
    runWithSessionTranscriptReadFence(admission, () =>
      resolveSqliteSessionTranscriptReadFence({
        database: { path: target.storePath },
        ...target,
      }),
    );
    if (selection) {
      const transcript = readSessionActorTranscriptAnchors(
        hot,
        { agentId: target.agentId, path: target.storePath, sessionId: target.sessionId },
        selection,
        retained?.tail,
        retained?.anchors,
      );
      if (!transcript) {
        return undefined;
      }
      prepared.transcript = transcript;
    } else {
      delete prepared.transcript;
    }
    return prepared;
  };
  const retainRead = (prepared: PreparedSessionTranscriptHydration) => {
    if (prepared.kind !== "bounded" || !contextLimits || "compaction" in contextLimits) {
      return;
    }
    const hot = readOwnedSessionTranscriptState(target);
    if (!hot) {
      return;
    }
    const retained = seedSessionActorTranscriptContext(
      readSessionActorTranscriptReplica(hot),
      hot,
      prepared,
      contextLimits,
      admission,
    );
    if (retained) {
      retainSessionActorTranscriptReplica(hot, retained);
    }
  };
  const read: SessionTranscriptHydrationReader["read"] = async (options) => {
    signal?.throwIfAborted();
    const retained = retainedRead();
    if (retained) {
      return retained;
    }
    const prepared = await readInOwner<PreparedSessionTranscriptHydration>((owner, resolvedScope) =>
      owner.readTranscript(
        { target, resolvedScope, limits: contextLimits, admission, ...options },
        signal,
      ),
    );
    retainRead(prepared);
    return prepared;
  };
  const readCohort: SessionTranscriptHydrationReader["readCohort"] = contextLimits
    ? (selection, consume) => {
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
            await readRestoredSessionTranscriptInWorker(
              { scope, resolved, owner, assertCurrent: assertSource },
              () =>
                runOpenClawAgentWriteAdmission(
                  database,
                  async (_identity, assertOwner) => {
                    assertSource();
                    const assertNative = captureSessionEntryNativeMutationWitness([database]);
                    const prepared =
                      retainedRead(selection) ??
                      (await owner.readTranscript(
                        {
                          target: scope,
                          resolvedScope: resolved,
                          expectedIdentity,
                          limits: contextLimits,
                          admission,
                          transcript: selection,
                          preparedEntry: readOwnedSessionTranscriptEntry(target),
                        },
                        signal,
                      ));
                    signal?.throwIfAborted();
                    assertOwner();
                    assertSource();
                    assertNative();
                    retainRead(prepared);
                    const consumed = consume(prepared);
                    if (isPromiseLike(consumed)) {
                      void Promise.resolve(consumed).catch(() => {});
                      throw new Error("Transcript cohort consumers must remain synchronous");
                    }
                  },
                  true,
                  undefined,
                  signal,
                  "history.hydration",
                ),
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
