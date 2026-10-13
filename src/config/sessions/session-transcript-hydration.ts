import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { readOpenClawAgentDatabase } from "../../state/openclaw-agent-db-readonly-open.js";
import {
  assertAgentDatabaseTerminalOpenAllowed,
  revalidateAgentDatabaseTerminalOpenAsync,
} from "../../state/openclaw-agent-db-terminal.js";
import { getOpenClawAgentDatabaseIfOpen } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  readLatestSessionTranscriptMessageEvent,
  readRecentSessionTranscriptActiveEvents,
} from "./session-accessor.sqlite-active-events.js";
import { readSessionTranscriptCurrentTurnEntry } from "./session-accessor.sqlite-current-turn.js";
import { loadTranscriptReadSnapshotSync } from "./session-accessor.sqlite-read.js";
import {
  prepareSqliteTranscriptReadScope,
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
  type ResolvedTranscriptReadScope,
} from "./session-accessor.sqlite-scope.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readRestoredSessionTranscript } from "./session-cold-storage-read.js";
import type { SessionEntryCohortRequest } from "./session-entry-read.types.js";
import type { IncognitoSessionActor } from "./session-incognito-actor.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type {
  IncognitoHistoryOperations,
  IncognitoHistoryTarget,
} from "./session-incognito-history-contract.js";
import type { SessionTranscriptMaintenanceRead } from "./session-transcript-hydration.types.js";
import { readSessionTranscriptMaintenance } from "./session-transcript-maintenance-read.js";
import {
  resolveSessionTranscriptReadFence,
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
  ) => Promise<IncognitoHistoryOperations["session.history.maintenance"]["output"]>;
  readRecentActiveEvents: (
    maxEvents: number,
  ) => Promise<IncognitoHistoryOperations["session.history.recent-active-events"]["output"]>;
  readLatestActiveMessage: () => Promise<
    IncognitoHistoryOperations["session.history.latest-active-message"]["output"]
  >;
};

/** Inactive until P7d: the caller supplies the sole actor for this captured session. */
export function prepareIncognitoSessionTranscriptHydration(params: {
  actor: IncognitoSessionActor;
  authority: IncognitoSessionAuthority;
  target: IncognitoHistoryTarget;
  limits?: { maxBytes: number; maxEvents: number };
  signal?: AbortSignal;
}): SessionTranscriptHydrationReader {
  const { actor, authority, signal } = params;
  actor.assertCurrent();
  authority.assertCurrent();
  const captured = structuredClone(params.target);
  const limits = params.limits ? { ...params.limits } : undefined;
  const target = captureSessionTranscriptTargetBinding({
    agentId: actor.agentId,
    storePath: actor.path,
    sessionKey: captured.sessionKey,
    sessionId: captured.sessionId,
  });
  captured.admission ??= resolveSessionTranscriptReadFence(target);
  const claim = actor.sessions.captureCurrent(captured.sessionKey);
  const assertCurrent = () => {
    signal?.throwIfAborted();
    actor.assertCurrent();
    authority.assertCurrent();
    claim.assertCurrent();
  };
  const boundAuthority: IncognitoSessionAuthority = {
    assertCurrent,
    authorize: (stage, facts) => authority.authorize?.(stage, facts),
  };
  const read = async <Key extends keyof IncognitoHistoryOperations>(
    type: Key,
    input: IncognitoHistoryOperations[Key]["input"],
  ): Promise<IncognitoHistoryOperations[Key]["output"]> => {
    assertCurrent();
    const value = await actor.sessions.history(boundAuthority, { type, input }, signal);
    assertCurrent();
    return value;
  };
  return {
    target,
    assertCurrent,
    read: () => read("session.history.hydrate", { ...captured, limits }),
    readCurrentTurnEntry: (request) =>
      read("session.history.current-turn-entry", {
        ...captured,
        entryId: request.entryId,
        version: { ...request.version },
        includeEntry: request.includeEntry,
      }),
    readMaintenance: (request) => read("session.history.maintenance", { ...captured, request }),
    readRecentActiveEvents: (maxEvents) =>
      read("session.history.recent-active-events", { ...captured, maxEvents }),
    readLatestActiveMessage: () => read("session.history.latest-active-message", captured),
  };
}

/** Capture identity before queueing; a missing file remains the creation owner's responsibility. */
export function prepareSessionTranscriptHydration(
  source: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv },
  limits?: { maxBytes: number; maxEvents: number },
  signal?: AbortSignal,
  lane?: SessionHistoryWorkerLane,
): SessionTranscriptHydrationReader {
  const incognito = captureIncognitoSessionHistoryBinding(source);
  if (incognito) {
    return prepareIncognitoSessionTranscriptHydration({ ...incognito, limits, signal });
  }
  const target = captureSessionTranscriptTargetBinding(source);
  const contextLimits = limits
    ? { maxBytes: limits.maxBytes, maxEvents: limits.maxEvents }
    : undefined;
  const receipt = resolveSessionTranscriptReadFence(target);
  const admission = receipt ? { ...receipt } : undefined;
  signal?.throwIfAborted();
  const incognitoOptions = isIncognitoSessionKey(target.sessionKey)
    ? toDatabaseOptions(resolveSqliteTranscriptReadScope(target))
    : undefined;
  const incognitoOwner = incognitoOptions
    ? getOpenClawAgentDatabaseIfOpen(incognitoOptions)
    : undefined;
  const assertCurrent = () => {
    if (incognitoOptions && getOpenClawAgentDatabaseIfOpen(incognitoOptions) !== incognitoOwner) {
      throw new Error("Session transcript incognito database owner is no longer current");
    }
  };
  const readInOwner = async <T>(
    readInProcess: () => T,
    readInWorker: (
      owner: SessionHistoryWorkerDatabase,
      resolvedScope: ResolvedTranscriptReadScope,
    ) => Promise<T>,
  ): Promise<T> => {
    signal?.throwIfAborted();
    // Incognito SQLite belongs to this process; never substitute another memory database.
    if (incognitoOptions) {
      return runWithSessionTranscriptReadFence(admission, readInProcess);
    }
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
    readInOwner<PreparedSessionTranscriptHydration>(
      () =>
        contextLimits
          ? {
              kind: "bounded",
              snapshot: readSessionTranscriptBoundedActiveContextCore(target, {
                ...contextLimits,
                readOnly: true,
              }),
            }
          : { kind: "full", snapshot: loadTranscriptReadSnapshotSync(target, { readOnly: true }) },
      (owner, resolvedScope) =>
        owner.readTranscript({ target, resolvedScope, limits: contextLimits, admission }, signal),
    );
  const readCohort: SessionTranscriptHydrationReader["readCohort"] =
    contextLimits && !incognitoOptions
      ? (selection, consume) => {
          const capturedSelection = structuredClone(selection);
          return withSessionTranscriptReadSource(
            target,
            () => {
              throw new Error("Bounded transcript cohorts require their durable history owner");
            },
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
    return readInOwner(
      () => readSessionTranscriptCurrentTurnEntry(target, { ...request, readOnly: true }),
      (owner, resolvedScope) =>
        owner.readCurrentTurnEntry({ ...request, target, resolvedScope, admission }, signal),
    );
  };
  const readMaintenance = (request: SessionTranscriptMaintenanceRead) =>
    readInOwner(
      () => {
        assertCurrent();
        if (!incognitoOwner) {
          throw new Error("Session transcript is unavailable for maintenance planning");
        }
        return readOpenClawAgentDatabase(incognitoOwner, (database) =>
          readSessionTranscriptMaintenance(database, target, request),
        ).value;
      },
      (owner, resolvedScope) =>
        owner.readMaintenance({ target, resolvedScope, admission, request }, signal),
    );
  const readRecentActiveEvents = (maxEvents: number) =>
    readInOwner(
      () => readRecentSessionTranscriptActiveEvents(target, maxEvents, { readOnly: true }),
      (owner, resolvedScope) =>
        owner.readRecentActiveEvents({ target, resolvedScope, maxEvents, admission }, signal),
    );
  const readLatestActiveMessage = () =>
    readInOwner(
      () => readLatestSessionTranscriptMessageEvent(target, { readOnly: true }),
      (owner, resolvedScope) =>
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
    assertCurrent,
  };
}
