import { hasSqliteDatabaseSchemaAdmissionForPath } from "../../infra/sqlite-database-admission.js";
import { WorkerTaskError } from "../../infra/worker-task-pool.js";
import type { WorkerTaskOptions, WorkerTaskResponse } from "../../infra/worker-task-pool.types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runWithAgentDatabaseReadAdmissionTurn } from "../../state/agent-database-admission.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseReadValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import type { SessionBranchSummaryReadRequest } from "./session-accessor.sqlite-branches.js";
import { readSessionActorProjectionReceipt } from "./session-actor-replica.js";
import { unwrapSessionTranscriptWorkerReply } from "./session-history-worker-errors.js";
import {
  createSessionHistoryWorkerReaders,
  type SessionHistoryWorkerRequestRunner,
} from "./session-transcript-worker-readers.js";
import {
  acquireHistoryDatabaseResource,
  armDatabaseWorkerIdleRetirement,
  clearDatabaseWorkerIdleRetirement,
  historyLane,
  maintenanceLane,
  pruneHistoryDatabases,
  refreshDatabaseWorkerPressureSubscription,
  rotateDatabaseWorkers,
  settleSessionHistoryWorkerEviction,
  targetDiscoveryLane,
  type HistoryDatabaseResource,
  type SessionHistoryDatabaseTarget,
  type SessionHistoryWorkerLane,
} from "./session-transcript-worker-resources.js";
import type {
  SessionHistoryWorkerDatabase,
  SessionHistoryWorkerInput,
  SessionHistoryWorkerPreparedInput,
  SessionTranscriptWorkerRequest,
  SessionTranscriptWorkerValues,
} from "./session-transcript-worker.types.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";

export type { SessionHistoryWorkerDatabase } from "./session-transcript-worker.types.js";

type ReadAdmission = <T>(
  dispatch: (signal: AbortSignal | undefined, remainingMs: number) => Promise<T>,
) => Promise<T>;

const log = createSubsystemLogger("sessions/history-worker");
const historyPrewarms = new WeakMap<
  HistoryDatabaseResource,
  Map<SessionHistoryWorkerLane, { promise: Promise<void>; pending: boolean }>
>();

function projectionTarget(input: SessionHistoryWorkerPreparedInput) {
  switch (input.kind) {
    case "history-page":
      return input.request.kind === "active-accounting" ? input.target.transcript : undefined;
    case "transcript-hydration":
    case "current-turn-entry":
    case "recent-active-events":
    case "latest-active-message":
      return input.resolvedScope;
    case "transcript-anchors":
      return input.resolved;
    case "session-activity-summary-source":
      return input.scope;
    default:
      return undefined;
  }
}

export function runSessionBranchSummaryWorkerRequest(
  request: SessionBranchSummaryReadRequest,
  signal?: AbortSignal,
) {
  const { database, ...read } = request;
  return withSessionHistoryWorkerDatabase(
    database,
    (owner) => owner.readBranchSummaries({ request: read }, signal),
    maintenanceLane,
  );
}

export function isSessionHistoryWorkerCold(lane: SessionHistoryWorkerLane = historyLane): boolean {
  return lane.pending === 0 && !lane.native;
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
    if (existing && (existing.pending || resource.nativeLanes.has(lane))) {
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
  clearDatabaseWorkerIdleRetirement(lane);
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
      let retirement: Promise<void> | undefined;
      const hostEffects = new Set<Promise<WorkerTaskResponse>>();
      /** Retain schema admission through reply processing without locking the consumer. */
      const readAdmissionOptions = { ...options, ...database, lane };
      const readRequest = {
        knownSource,
        timeoutMs,
        signal,
        aborters: owned.aborters,
      };
      const { lane: requestedLane, ...readOptions } = readAdmissionOptions;
      const deadline = performance.now() + readRequest.timeoutMs;
      const remainingTime = () => {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new WorkerTaskError("worker task timed out", "timeout");
        }
        return remaining;
      };
      let additionalLane: SessionHistoryWorkerLane | undefined;
      try {
        const cold =
          !readRequest.knownSource && !hasSqliteDatabaseSchemaAdmissionForPath(readOptions.path);
        const requestLane = cold ? targetDiscoveryLane : requestedLane;
        if (requestLane !== requestedLane) {
          clearDatabaseWorkerIdleRetirement(requestLane);
          requestLane.pending++;
          additionalLane = requestLane;
          refreshDatabaseWorkerPressureSubscription();
        }
        const admit: ReadAdmission = async (dispatch) => {
          const start = (admissionSignal: AbortSignal | undefined) => {
            return dispatch(admissionSignal, remainingTime());
          };
          const dispatchCold = async () => {
            const controller = new AbortController();
            const admissionSignal = readRequest.signal
              ? AbortSignal.any([readRequest.signal, controller.signal])
              : controller.signal;
            const abort = () =>
              controller.abort(
                new WorkerTaskError("Session history database read was revoked", "unavailable"),
              );
            readRequest.aborters.add(abort);
            const timer = setTimeout(
              () => controller.abort(new WorkerTaskError("worker task timed out", "timeout")),
              Math.max(1, deadline - performance.now()),
            );
            timer.unref?.();
            try {
              return await runWithAgentDatabaseReadAdmissionTurn(
                [readOptions.path],
                () => {
                  // The pool owns dispatch and host-response budgets after admission.
                  clearTimeout(timer);
                  return start(admissionSignal);
                },
                [],
                admissionSignal,
                options,
              );
            } finally {
              clearTimeout(timer);
              readRequest.aborters.delete(abort);
            }
          };
          // First creation shares schema admission; pure reads never reserve the writer.
          return cold ? dispatchCold() : start(readRequest.signal);
        };
        try {
          const reply = await admit((requestSignal, remaining) => {
            // A writer ahead of this read can renew the receipt during admission.
            const validation = captureOpenClawAgentDatabaseReadValidation(
              database,
              owned.nativeLanes.has(requestLane) ? "retained" : "admission",
            );
            return runWithAgentDatabaseReadAdmissionTurn(
              [database.path],
              () =>
                requestLane.pool.run(
                  () => {
                    assertCurrent();
                    options.prepareRead?.();
                    const input = prepare();
                    const projection = projectionTarget(input);
                    const projectionReceipt = projection?.sessionId
                      ? readSessionActorProjectionReceipt({
                          path: database.path,
                          sessionKey: projection.sessionKey,
                          sessionId: projection.sessionId,
                        })
                      : undefined;
                    requestLane.native = true;
                    owned.nativeLanes.add(requestLane);
                    return {
                      ...input,
                      database,
                      validation: validation?.validation,
                      projectionReceipt: projectionReceipt && {
                        ...projectionReceipt,
                        ...(input.kind === "history-page" && !projectionReceipt.entrySessionKey
                          ? { contextOnly: true }
                          : {}),
                      },
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
              [],
              requestSignal,
              options,
            );
          });
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
              received.kind === "session-runtime-target") &&
            received.source
          ) {
            knownSource = true;
          }
          // SAFETY: The pool pairs this reply with the exact prepared request above.
          const paired = received as SessionTranscriptWorkerValues[ReturnType<
            typeof prepare
          >["kind"]];
          const value = receive(paired);
          if (reply.ok && reply.closedHistoryDatabase) {
            await settleSessionHistoryWorkerEviction(requestLane, reply.closedHistoryDatabase);
          }
          return value;
        } finally {
          // Cancellation removes queued effects; accepted writes still retain settlement custody.
          await Promise.allSettled(hostEffects);
        }
      } finally {
        if (additionalLane) {
          additionalLane.pending--;
          armDatabaseWorkerIdleRetirement(additionalLane);
        }
      }
    };
    const owner: SessionHistoryWorkerDatabase = Object.assign(
      createSessionHistoryWorkerReaders(runRequest),
      { assertCurrent },
    );
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

/** Single-target callers retain the same admission and revocation boundary. */
export async function withSessionHistoryWorkerDatabase<T>(
  options: SessionHistoryDatabaseTarget,
  operation: (owner: SessionHistoryWorkerDatabase) => Promise<T>,
  lane: SessionHistoryWorkerLane = historyLane,
): Promise<T> {
  const retained = retainSessionHistoryWorkerDatabase(options, lane);
  try {
    return await operation(retained.owner);
  } finally {
    retained.release();
  }
}

/** Process-held sources exchange bounded pages without reopening their memory database. */
export async function runProcessHeldHistoryTask(
  request: import("./session-history-types.js").ChatHistoryDisplayRequest,
  onRequest: NonNullable<WorkerTaskOptions<SessionHistoryWorkerInput>["onRequest"]>,
  signal?: AbortSignal,
) {
  historyLane.pending++;
  clearDatabaseWorkerIdleRetirement(historyLane);
  refreshDatabaseWorkerPressureSubscription();
  let retirement: Promise<void> | undefined;
  try {
    await historyLane.rotation;
    const value = unwrapSessionTranscriptWorkerReply<SessionHistoryWorkerInput["kind"]>(
      await historyLane.pool.run(
        () => {
          historyLane.native = true;
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
