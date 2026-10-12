import { expectDefined } from "@openclaw/normalization-core";
import { runWithSqliteDatabaseAdmissionTurn } from "../../infra/sqlite-database-admission-turn.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions, WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { SessionBranchSummaryReadRequest } from "./session-accessor.sqlite-branches.js";
import { unwrapSessionTranscriptWorkerReply } from "./session-history-worker-errors.js";
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
  type SessionHistoryDatabaseTarget,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import type {
  SessionHistoryWorkerDatabase,
  SessionHistoryWorkerInput,
  SessionTranscriptWorkerRequest,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

const log = createSubsystemLogger("sessions/history-worker");
const historyPrewarms = new WeakMap<
  HistoryDatabaseResource,
  Map<SessionHistoryWorkerLane, { promise: Promise<void>; pending: boolean }>
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
    if (existing && (existing.pending || resource.nativeSequences.has(lane))) {
      return await existing.promise;
    }
    const prewarm: { promise: Promise<void>; pending: boolean } = {
      promise: withSessionHistoryWorkerDatabase(
        options,
        (owner) =>
          owner.prewarm({
            env: captureSessionTranscriptStorageEnvironment(options.env ?? process.env),
          }),
        lane,
      ).then(
        () => {
          prewarm.pending = false;
        },
        (error: unknown) => {
          prewarms.delete(lane);
          log.debug(`Session history worker prewarm failed: ${String(error)}`);
        },
      ),
      pending: true,
    };
    prewarms.set(lane, prewarm);
    await prewarm.promise;
  } catch (error) {
    log.debug(`Session history worker prewarm failed: ${String(error)}`);
  }
}

/** Single and batch reads synchronously retain the same lane-aware database owner. */
export function retainSessionHistoryWorkerDatabase(
  options: SessionHistoryDatabaseTarget,
  lane: SessionHistoryWorkerLane = historyLane,
) {
  const owned = acquireHistoryDatabaseResource(options);
  const { database } = owned;
  let knownSource = false;
  const assertCurrent = () => {
    if (owned.revoked) {
      throw new WorkerTaskError("Session history database read was revoked", "unavailable");
    }
  };
  historyClearTimeout(lane.idleTimer);
  lane.pending++;
  owned.pending++;
  refreshDatabaseWorkerPressureSubscription();
  let released = false;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    owned.pending--;
    lane.pending--;
    armDatabaseWorkerIdleRetirement(lane);
    pruneHistoryDatabases();
  };
  try {
    const runRequest: SessionHistoryWorkerRequestRunner = async (
      prepare,
      inputBytes,
      receive,
      signal,
      onRequest,
      timeoutMs = 60_000,
    ) => {
      const validation = captureOpenClawAgentDatabaseReadValidation(database);
      let retirement: Promise<void> | undefined;
      const hostEffects = new Set<Promise<WorkerTaskResponse>>();
      return withSessionHistoryReadAdmission(
        { ...options, ...database, lane },
        {
          knownSource,
          timeoutMs,
          signal,
          aborters: owned.aborters,
        },
        async (admit, requestLane) => {
          try {
            const reply = await admit((requestSignal, remaining) =>
              runWithSqliteDatabaseAdmissionTurn([database.path], () =>
                requestLane.pool.run(
                  () => {
                    assertCurrent();
                    const input = prepare();
                    owned.nativeSequences.set(requestLane, ++requestLane.nativeSequence);
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
                            const response = await onRequest(value, context.signal);
                            context.signal.throwIfAborted();
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
              knownSource = true;
            }
            const value = receive(received);
            if (reply.ok && reply.closedHistoryDatabase) {
              await settleSessionHistoryWorkerEviction(requestLane, reply.closedHistoryDatabase);
            }
            return value;
          } finally {
            // Cancellation removes queued effects; accepted writes still retain settlement custody.
            await Promise.allSettled(hostEffects);
          }
        },
      );
    };
    const owner: SessionHistoryWorkerDatabase = {
      assertCurrent,
      ...createSessionHistoryWorkerReaders(runRequest),
    };
    return { owner, release };
  } catch (error) {
    release();
    throw error;
  }
}

/** Retain each selected reader for the operation. */
export async function withSessionHistoryWorkerDatabases<T>(
  options: readonly SessionHistoryDatabaseTarget[],
  operation: (owners: readonly SessionHistoryWorkerDatabase[]) => Promise<T>,
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<T> {
  const retained: ReturnType<typeof retainSessionHistoryWorkerDatabase>[] = [];
  try {
    for (const target of options) {
      retained.push(retainSessionHistoryWorkerDatabase(target, lane));
    }
    return await operation(retained.map(({ owner }) => owner));
  } finally {
    for (const retainedRead of retained.toReversed()) {
      retainedRead.release();
    }
  }
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
  let retirement: Promise<void> | undefined;
  try {
    await historyLane.rotation;
    const value = unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(
      await historyLane.pool.run(
        () => {
          historyLane.nativeSequence++;
          return { kind: "cli-process-history", request };
        },
        {
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
  } finally {
    historyLane.pending--;
    armDatabaseWorkerIdleRetirement(historyLane);
  }
}
