import { expectDefined } from "@openclaw/normalization-core";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions, WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import { isIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { resolveStateDir } from "../state-dir.js";
import type { SessionBranchSummaryReadRequest } from "./session-accessor.sqlite-branches.js";
import { loadSessionEntryReadOnlyInScope } from "./session-accessor.sqlite-exact-read.js";
import {
  resolveSqliteScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import type { SessionAccessScope } from "./session-accessor.types.js";
import type { CapturedSessionEntryReadSource } from "./session-entry-read-source.types.js";
import {
  sessionHistoryCleanupError,
  unwrapSessionTranscriptWorkerReply,
} from "./session-history-worker-errors.js";
import {
  captureIncognitoSessionSource,
  withIncognitoSessionEntry,
} from "./session-incognito-binding.js";
import { resolveSessionStorePathForScope } from "./session-store-path.js";
import { withSessionHistoryReadAdmission } from "./session-transcript-worker-read-admission.js";
import {
  createSessionHistoryWorkerReaders,
  type SessionHistoryWorkerRequestRunner,
} from "./session-transcript-worker-readers.js";
import {
  acquireHistoryDatabaseResource,
  armDatabaseWorkerIdleRetirement,
  historyClearTimeout,
  historyLane,
  maintenanceLane,
  pruneHistoryDatabases,
  refreshDatabaseWorkerPressureSubscription,
  rotateDatabaseWorkers,
  settleSessionHistoryWorkerEviction,
  type HistoryDatabaseResource,
  type SessionDatabaseCleanup,
  type SessionHistoryDatabaseTarget,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import type {
  SessionHistoryWorkerDatabase,
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerRequest,
  SessionRowPresenceWorkerInput,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

const log = createSubsystemLogger("sessions/history-worker");
const historyPrewarms = new WeakMap<
  HistoryDatabaseResource,
  Map<
    SessionHistoryWorkerLane,
    { promise: Promise<void>; pending: boolean; retiredSequence: number }
  >
>();

export function runSessionBranchSummaryWorkerRequest(
  request: SessionBranchSummaryReadRequest,
  signal: AbortSignal,
) {
  const { database, ...read } = request;
  return withSessionHistoryWorkerDatabase(
    database,
    (owner) => owner.readBranchSummaries({ request: read }, signal),
    maintenanceLane,
  );
}

export function isSessionHistoryWorkerCold(lane: SessionHistoryWorkerLane = historyLane): boolean {
  return lane.pending === 0 && lane.nativeSequence <= lane.retiredSequence;
}

/** Reuse normal reader custody; repeated warmups never refresh the idle deadline. */
export async function prewarmSessionHistoryWorker(
  options: OpenClawAgentDatabaseOptions,
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<void> {
  try {
    const resource = acquireHistoryDatabaseResource(options);
    let prewarms = historyPrewarms.get(resource);
    if (!prewarms) {
      prewarms = new Map();
      historyPrewarms.set(resource, prewarms);
    }
    const existing = prewarms.get(lane);
    if (
      existing &&
      (existing.pending ||
        (!lane.rotation &&
          existing.retiredSequence === lane.retiredSequence &&
          resource.nativeSequences.has(lane)))
    ) {
      return await existing.promise;
    }
    const completion = createDeferredCore();
    const prewarm = {
      promise: completion.promise,
      pending: true,
      retiredSequence: lane.retiredSequence,
    };
    prewarms.set(lane, prewarm);
    void withSessionHistoryWorkerDatabase(
      options,
      (owner) =>
        owner.prewarm({
          env: captureSessionTranscriptStorageEnvironment(options.env ?? process.env),
        }),
      lane,
    ).then(
      () => {
        prewarm.pending = false;
        completion.resolve();
      },
      (error: unknown) => {
        prewarms.delete(lane);
        log.debug(`Session history worker prewarm failed: ${String(error)}`);
        completion.resolve();
      },
    );
    await completion.promise;
  } catch (error) {
    log.debug(`Session history worker prewarm failed: ${String(error)}`);
  }
}

/** Capture the exact metadata owner before initial-writer admission can wait. */
export function prepareSessionEntryPresenceRead(input: SessionAccessScope): Readonly<{
  sessionKey: string;
  storePath: string;
  read: () => Promise<boolean>;
}> {
  const binding = captureIncognitoSessionSource(input);
  if (binding) {
    const owner = "kind" in binding ? binding : binding.actor;
    const storePath = owner.path;
    const sessionKey = resolveSqliteSessionKey(input.sessionKey, owner.agentId);
    return {
      sessionKey,
      storePath,
      read: () =>
        withIncognitoSessionEntry(
          binding,
          sessionKey,
          () => {},
          async (entry) => Boolean(entry),
        ),
    };
  }
  const env = { ...(input.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const storePath = resolveSessionStorePathForScope({ ...input, env });
  const resolved = resolveSqliteScope({ ...input, storePath, env });
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const scope: SessionRowPresenceWorkerInput["scope"] = {
    agentId: resolved.agentId,
    sessionKey: resolved.sessionKey,
    storePath: databasePath,
    databaseAgentId: options.agentId,
    env,
  };
  const incognito = isIncognitoOpenClawAgentSqlitePath(databasePath, options);
  return {
    sessionKey: resolved.sessionKey,
    storePath,
    read: incognito
      ? async () => loadSessionEntryReadOnlyInScope({ ...scope, projection: "list" }) !== undefined
      : async () =>
          await withSessionHistoryWorkerDatabase(
            options,
            async (owner) => await owner.readEntryPresence(scope),
          ),
  };
}

/** Single and batch reads synchronously retain the same lane-aware database owner. */
export function retainSessionHistoryWorkerDatabase(
  options: SessionHistoryDatabaseTarget,
  lane: SessionHistoryWorkerLane = historyLane,
) {
  const owned = acquireHistoryDatabaseResource(options);
  const { database } = owned;
  let entryReadSource: (CapturedSessionEntryReadSource & { databaseIdentity: string }) | undefined;
  const assertCurrent = () => {
    if (owned.revoked) {
      throw new WorkerTaskError("Session history database read was revoked", "unavailable");
    }
    if (entryReadSource) {
      assertExistingDatabaseIdentity(
        database.path,
        `file:${entryReadSource.databaseIdentity}`,
        entryReadSource.databaseBirthtime,
      );
    }
  };
  historyClearTimeout(lane.idleTimer);
  lane.pending++;
  owned.pending++;
  refreshDatabaseWorkerPressureSubscription();
  let countsReleased = false;
  let releaseFinished = false;
  const releaseCleanup: SessionDatabaseCleanup = { run: async () => release() };
  const release = () => {
    if (releaseFinished) {
      return;
    }
    // Keep the existing database resource registered until all release steps succeed.
    owned.cleanups.add(releaseCleanup);
    if (!countsReleased) {
      countsReleased = true;
      owned.pending--;
      lane.pending--;
    }
    try {
      armDatabaseWorkerIdleRetirement(lane);
      owned.cleanups.delete(releaseCleanup);
      pruneHistoryDatabases();
      releaseFinished = true;
    } catch (error) {
      owned.cleanups.add(releaseCleanup);
      throw error;
    }
  };
  try {
    assertCurrent();
    const runRequest: SessionHistoryWorkerRequestRunner = async (
      prepare,
      inputBytes,
      receive,
      signal,
      onRequest,
      timeoutMs = 60_000,
    ) => {
      assertCurrent();
      const validation = captureOpenClawAgentDatabaseReadValidation(database);
      const assertRequestCurrent = () => {
        assertCurrent();
        validation?.assertCurrent();
      };
      let sequence = 0;
      let retirement: Promise<void> | undefined;
      const hostEffects = new Set<Promise<WorkerTaskResponse>>();
      return withSessionHistoryReadAdmission(
        { ...options, ...database, lane },
        {
          knownSource: entryReadSource !== undefined,
          timeoutMs,
          signal,
          aborters: owned.aborters,
          assertCurrent: assertRequestCurrent,
        },
        async (admit, requestLane) => {
          try {
            const reply = await admit((requestSignal, remaining) =>
              runWithSqliteDatabaseAdmissionTurn([database.path], () =>
                requestLane.pool.run(
                  () => {
                    assertRequestCurrent();
                    const input = prepare();
                    assertRequestCurrent();
                    sequence = ++requestLane.nativeSequence;
                    owned.nativeSequences.set(requestLane, sequence);
                    return {
                      ...input,
                      database,
                      validation: validation?.validation,
                    } satisfies SessionTranscriptWorkerRequest;
                  },
                  {
                    inputBytes: inputBytes + (validation?.inputBytes ?? 0),
                    timeoutMs: remaining,
                    signal: requestSignal,
                    onRequest: onRequest
                      ? (value, context) => {
                          const effect = (async () => {
                            context.signal.throwIfAborted();
                            assertRequestCurrent();
                            const response = await onRequest(value, context.signal);
                            context.signal.throwIfAborted();
                            assertRequestCurrent();
                            return response ?? { input: null, timeoutMs };
                          })();
                          hostEffects.add(effect);
                          owned.hostEffects.add(effect);
                          const releaseEffect = () => {
                            hostEffects.delete(effect);
                            owned.hostEffects.delete(effect);
                          };
                          void effect.then(releaseEffect, releaseEffect);
                          return effect;
                        }
                      : undefined,
                    onExecutionSettled: ({ retired }) => {
                      if (retired) {
                        retirement = rotateDatabaseWorkers(requestLane);
                      }
                    },
                  },
                ),
              ),
            );
            await retirement;
            const received =
              unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(reply);
            if (
              typeof received !== "boolean" &&
              !Array.isArray(received) &&
              (received.kind === "session-entry-read" ||
                received.kind === "session-entry-list" ||
                received.kind === "session-cleanup" ||
                received.kind === "session-exact-entries" ||
                received.kind === "session-entry-current" ||
                received.kind === "session-runtime-target" ||
                received.kind === "session-diagnostic-text") &&
              received.source
            ) {
              const source = received.source;
              if (
                source.agentId !== database.agentId ||
                source.path !== database.path ||
                (entryReadSource &&
                  (entryReadSource.databaseIdentity !== source.databaseIdentity ||
                    entryReadSource.databaseBirthtime !== source.databaseBirthtime))
              ) {
                throw new Error("Session entry read changed its retained physical owner");
              }
              // Retain the identity that actually supplied the row, not a later stat of its locator.
              entryReadSource = source;
            }
            assertRequestCurrent();
            const value = receive(received);
            if (reply.ok && reply.closedHistoryDatabase) {
              await settleSessionHistoryWorkerEviction(requestLane, reply.closedHistoryDatabase);
            }
            assertRequestCurrent();
            return value;
          } catch (error) {
            if (sequence > 0) {
              try {
                await (retirement ?? rotateDatabaseWorkers(requestLane));
              } catch (cleanupError) {
                throw sessionHistoryCleanupError(error, cleanupError, "worker retirement");
              }
            }
            throw error;
          } finally {
            // Cancellation removes queued effects; accepted writes still retain settlement custody.
            await Promise.allSettled(hostEffects);
          }
        },
      );
    };
    const owner: SessionHistoryWorkerDatabase = {
      generation: owned.generation,
      assertCurrent,
      ...createSessionHistoryWorkerReaders(runRequest),
    };
    return { owner, release };
  } catch (error) {
    try {
      release();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Session history reader admission cleanup failed",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

/** Capture every selected store before yielding; a closed target cannot join a later generation. */
export async function withSessionHistoryWorkerDatabases<T>(
  options: readonly SessionHistoryDatabaseTarget[],
  operation: (owners: readonly SessionHistoryWorkerDatabase[]) => Promise<T>,
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<T> {
  const retained: ReturnType<typeof retainSessionHistoryWorkerDatabase>[] = [];
  let outcome: { value: T } | { error: unknown };
  try {
    for (const target of options) {
      retained.push(retainSessionHistoryWorkerDatabase(target, lane));
    }
    const value = await operation(retained.map(({ owner }) => owner));
    for (const { owner } of retained) {
      owner.assertCurrent();
    }
    outcome = { value };
  } catch (error) {
    outcome = { error };
  }
  const cleanupErrors: unknown[] = [];
  for (const retainedRead of retained.toReversed()) {
    try {
      retainedRead.release();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [...("error" in outcome ? [outcome.error] : []), ...cleanupErrors],
      "Session history read scope cleanup failed",
      { cause: "error" in outcome ? outcome.error : cleanupErrors[0] },
    );
  }
  if ("error" in outcome) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Single-target callers retain the same batch admission and revocation boundary. */
export function withSessionHistoryWorkerDatabase<T>(
  options: SessionHistoryDatabaseTarget,
  operation: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<T> {
  return withSessionHistoryWorkerDatabases(
    [options],
    (owners) => operation(expectDefined(owners[0], "retained session history reader")),
    lane,
  );
}

/** Process-held sources exchange bounded pages without reopening their memory database. */
export async function runProcessHeldHistoryTask(
  request: import("./session-history-types.js").ChatHistoryDisplayRequest,
  onRequest: NonNullable<WorkerTaskOptions<SessionHistoryWorkerInput>["onRequest"]>,
  signal?: AbortSignal,
) {
  historyLane.pending++;
  historyClearTimeout(historyLane.idleTimer);
  historyLane.idleTimer = undefined;
  refreshDatabaseWorkerPressureSubscription();
  let sequence = 0;
  let retirement: Promise<void> | undefined;
  try {
    await historyLane.rotation;
    const value = unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(
      await historyLane.pool.run(
        () => {
          sequence = ++historyLane.nativeSequence;
          return { kind: "cli-process-history", request };
        },
        {
          inputBytes: request.params.cliHistoryRedaction?.retainedBytes,
          timeoutMs: 60_000,
          onRequest,
          signal,
          onExecutionSettled: ({ retired }) => {
            if (retired) {
              retirement = rotateDatabaseWorkers(historyLane);
            }
          },
        },
      ),
    );
    await retirement;
    if (
      typeof value === "boolean" ||
      Array.isArray(value) ||
      (value.kind !== "rpc" && value.kind !== "rpc-message")
    ) {
      throw new Error("Unexpected process-held history reply");
    }
    return value;
  } catch (error) {
    if (sequence > 0) {
      try {
        await (retirement ?? rotateDatabaseWorkers(historyLane));
      } catch (cleanupError) {
        throw sessionHistoryCleanupError(error, cleanupError, "worker retirement");
      }
    }
    throw error;
  } finally {
    historyLane.pending--;
    armDatabaseWorkerIdleRetirement(historyLane);
  }
}
