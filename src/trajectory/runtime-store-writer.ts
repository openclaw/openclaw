import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  formatSqliteSessionFileMarker,
  parseSqliteSessionFileMarker,
} from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  resolveSqliteSessionKey,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  isNativeSessionEntryRead,
  withSessionEntriesFromStoresInWorker,
} from "../config/sessions/session-entry-read-runtime.js";
import { resolveStateDir } from "../config/state-dir.js";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../infra/sqlite-worker-operation-settlement.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type {
  OpenClawAgentDatabase,
  OpenClawAgentDatabaseOptions,
} from "../state/openclaw-agent-db-contract.js";
import { readOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  withOpenClawAgentDatabaseRuntime,
} from "../state/openclaw-agent-db.js";
import type { AgentDatabaseRequestExecutionSource } from "../state/openclaw-agent-execution-contract.js";
import {
  captureOpenClawAgentDatabaseExecution,
  supportsOpenClawAgentDatabaseExecution,
} from "../state/openclaw-agent-execution.js";
import {
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../state/openclaw-agent-write-admission.js";
import { scheduleSqliteTrajectoryRuntimeRetention } from "./runtime-retention.js";
import {
  appendSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeAppend,
} from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

type TrajectoryRuntimeSinkParams = {
  env: NodeJS.ProcessEnv;
  maxRuntimeFileBytes: number;
  sessionFile?: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  assertCommitAllowed?: () => void;
};

function captureTrajectoryTarget(params: TrajectoryRuntimeSinkParams) {
  return params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
}

export async function createSqliteTrajectoryRuntimeSink(input: TrajectoryRuntimeSinkParams) {
  const params = {
    ...input,
    env: { ...input.env, OPENCLAW_STATE_DIR: resolveStateDir(input.env) },
    sessionTarget: input.sessionTarget && { ...input.sessionTarget },
  };
  const target = captureTrajectoryTarget(params);
  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  if (target?.storePath && params.sessionTarget) {
    target.storePath = path.resolve(target.storePath);
    params.sessionTarget = { ...params.sessionTarget, storePath: target.storePath };
  }
  params.sessionFile = marker ? formatSqliteSessionFileMarker(marker) : params.sessionFile;
  const scope =
    target?.agentId && target.sessionId && target.sessionKey && target.storePath
      ? { agentId: target.agentId, sessionKey: target.sessionKey, storePath: target.storePath }
      : target?.sessionKey && marker
        ? { ...marker, sessionKey: target.sessionKey }
        : undefined;
  params.assertCommitAllowed?.();
  if (!scope || isNativeSessionEntryRead({ ...scope, env: params.env }, scope.agentId)) {
    return buildSqliteTrajectoryRuntimeSink(params, loadSessionEntry);
  }
  return withSessionEntriesFromStoresInWorker(
    [
      {
        ...scope,
        env: params.env,
        sessionKeys: [resolveSqliteSessionKey(scope.sessionKey, scope.agentId)],
        projection: "exact",
        snapshotFields: [],
      },
    ],
    ([read]) => {
      params.assertCommitAllowed?.();
      read!.assertCurrent();
      return buildSqliteTrajectoryRuntimeSink(params, () => read!.result.entries[0]?.entry, {
        agentId: read!.database.agentId,
        path: read!.database.path,
        env: read!.database.env,
      });
    },
    { ordered: true },
  );
}

function buildSqliteTrajectoryRuntimeSink(
  params: TrajectoryRuntimeSinkParams,
  readEntry: typeof loadSessionEntry,
  preparedDatabase?: OpenClawAgentDatabaseOptions,
) {
  const target = captureTrajectoryTarget(params);
  const legacyMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const completeTarget = Boolean(
    target?.agentId && target.sessionId && target.sessionKey && target.storePath,
  );
  const targetKeyAgentId = parseAgentSessionKey(target?.sessionKey)?.agentId;
  const requestedSessionKey = normalizeOptionalString(params.sessionKey);
  const completeTargetKeyEntry =
    completeTarget && target?.agentId && target.sessionKey && target.storePath
      ? readEntry({
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        })
      : undefined;
  // A prepared runtime target may precede its metadata row. Treat an absent
  // row as uncommitted, while rejecting an existing conflicting mapping.
  if (
    completeTarget &&
    ((requestedSessionKey && target?.sessionKey !== requestedSessionKey) ||
      (targetKeyAgentId && target?.agentId !== targetKeyAgentId) ||
      (completeTargetKeyEntry && completeTargetKeyEntry.sessionId !== target?.sessionId))
  ) {
    return null;
  }
  const targetKeyEntry =
    target?.sessionKey && legacyMarker && !completeTarget
      ? readEntry({
          agentId: legacyMarker.agentId,
          sessionKey: target.sessionKey,
          storePath: legacyMarker.storePath,
        })
      : undefined;
  if (
    target &&
    !completeTarget &&
    legacyMarker &&
    ((target.agentId && target.agentId !== legacyMarker.agentId) ||
      (target.sessionId && target.sessionId !== legacyMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== legacyMarker.agentId) ||
      (target.sessionKey && targetKeyEntry?.sessionId !== legacyMarker.sessionId) ||
      (target.storePath && path.resolve(target.storePath) !== path.resolve(legacyMarker.storePath)))
  ) {
    return null;
  }
  const marker =
    target?.agentId && target.sessionId && target.sessionKey && target.storePath
      ? {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        }
      : legacyMarker;
  if (!marker || marker.sessionId !== params.sessionId) {
    return null;
  }
  const env = { ...params.env };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const databaseOptions =
    preparedDatabase ?? toDatabaseOptions(resolveSqliteReadScope({ ...marker, env }));
  let pendingEvents = new Map<TrajectoryEvent, number>();
  let queuedBytes = 0;
  let discardPrevious = false;
  let inFlight:
    | { events: Map<TrajectoryEvent, number>; bytes: number; discardPrevious: boolean }
    | undefined;
  let unsettledAppend: SqliteWorkerError | undefined;
  const trimPending = () => {
    // Keep an oversized newest event so its append still expires the disk window.
    while (queuedBytes > params.maxRuntimeFileBytes && pendingEvents.size > 1) {
      const [oldest, oldestBytes] = pendingEvents.entries().next().value!;
      pendingEvents.delete(oldest);
      queuedBytes -= oldestBytes;
      discardPrevious = true;
    }
  };
  const flushPending = async () => {
    if (unsettledAppend) {
      throw unsettledAppend;
    }
    if (pendingEvents.size === 0 && !inFlight) {
      return;
    }
    await runOpenClawAgentWriteAdmission(
      databaseOptions,
      async () => {
        if (unsettledAppend) {
          throw unsettledAppend;
        }
        if (pendingEvents.size === 0) {
          return;
        }
        await withOpenClawAgentDatabaseRuntime(databaseOptions, async (database) => {
          // Admission transfers the batch; later arrivals cannot evict accepted rows.
          const batch = { events: pendingEvents, bytes: queuedBytes, discardPrevious };
          inFlight = batch;
          pendingEvents = new Map();
          queuedBytes = 0;
          discardPrevious = false;
          const events = [...batch.events.keys()];
          try {
            if (isMainThread && supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
              await appendSqliteTrajectoryRuntimeEventsInWorker(
                databaseOptions,
                database,
                {
                  events,
                  discardPrevious: batch.discardPrevious,
                  maxRuntimeBytes: params.maxRuntimeFileBytes,
                  sessionId: marker.sessionId,
                },
                params.assertCommitAllowed,
                (outcome) => {
                  if (outcome === "committed") {
                    inFlight = undefined;
                  } else {
                    unsettledAppend = new SqliteWorkerError(
                      "Trajectory append outcome is unknown; pending events cannot be replayed",
                      "outcome-unknown",
                    );
                  }
                },
              );
            } else {
              appendSqliteTrajectoryRuntimeEvents(
                {
                  agentId: marker.agentId,
                  discardPrevious: batch.discardPrevious,
                  env: databaseOptions.env,
                  maxRuntimeBytes: params.maxRuntimeFileBytes,
                  sessionId: marker.sessionId,
                  storePath: database.path,
                  assertCommitAllowed: params.assertCommitAllowed,
                },
                events,
              );
              inFlight = undefined;
            }
          } finally {
            if (inFlight === batch && !unsettledAppend) {
              inFlight = undefined;
              // A newer overflow already expires this failed prefix. Otherwise put
              // it back before the newer queue and apply the same rolling window.
              if (!discardPrevious) {
                for (const [event, bytes] of pendingEvents) {
                  batch.events.set(event, bytes);
                }
                pendingEvents = batch.events;
                queuedBytes += batch.bytes;
                discardPrevious = batch.discardPrevious;
                trimPending();
              }
            }
          }
        });
      },
      true,
    );
  };
  let backgroundFlush: Promise<void> | undefined;
  let backgroundFailed = false;
  const scheduleFlush = () => {
    if (
      backgroundFlush ||
      backgroundFailed ||
      unsettledAppend ||
      (pendingEvents.size < 32 && queuedBytes < 256 * 1024)
    ) {
      return;
    }
    backgroundFlush = flushPending()
      .catch(() => {
        backgroundFailed = true;
      })
      .finally(() => {
        backgroundFlush = undefined;
        scheduleFlush();
      });
  };
  return {
    describeFlushState: () =>
      pendingEvents.size > 0 || inFlight
        ? `pendingRows=${pendingEvents.size + (inFlight?.events.size ?? 0)} queuedBytes=${queuedBytes + (inFlight?.bytes ?? 0)} activeOperation=sqlite-append`
        : undefined,
    flush: async () => {
      await backgroundFlush;
      backgroundFailed = false;
      await flushPending();
    },
    write: (event: TrajectoryEvent, line: string) => {
      const bytes = Buffer.byteLength(line, "utf8") + 1;
      pendingEvents.set(event, bytes);
      queuedBytes += bytes;
      trimPending();
      scheduleFlush();
    },
  };
}

function createTrajectoryDatabaseGuard(
  options: OpenClawAgentDatabaseOptions,
  database: OpenClawAgentDatabase,
  assertCommitAllowed: (() => void) | undefined,
): () => void {
  return () => {
    // Retention keeps source authority without capturing a completed append batch.
    if (!database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options)?.db !== database.db) {
      throw new Error("Trajectory append lost its borrowed database owner");
    }
    assertCommitAllowed?.();
  };
}

async function appendSqliteTrajectoryRuntimeEventsInWorker(
  options: OpenClawAgentDatabaseOptions,
  database: OpenClawAgentDatabase,
  input: SqliteTrajectoryRuntimeAppend,
  assertCommitAllowed: (() => void) | undefined,
  settle: (outcome: "committed" | "unknown") => void,
): Promise<void> {
  const identity = readOpenClawAgentDatabaseIdentity(database);
  if (typeof identity.identity !== "string") {
    throw new Error("Trajectory worker requires a durable database owner");
  }
  const execution = captureOpenClawAgentDatabaseExecution(options, {
    expectedIdentity: {
      kind: "file",
      physicalIdentity: identity.identity,
      nativeLocation: identity.filename,
    },
  });
  const assertDatabaseCurrent = createTrajectoryDatabaseGuard(
    options,
    database,
    assertCommitAllowed,
  );
  const assertCurrent = () => {
    execution.assertCurrent();
    assertDatabaseCurrent();
  };
  let transaction:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent,
    createAdmission(binding) {
      return (retained) => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          if (request.stage === "transaction") {
            transaction = { admission, retained };
          }
          assertCurrent();
          if (!grant()) {
            throw new Error("Trajectory append authority expired");
          }
        }, binding.attachment);
        return { nativeLocations: binding.nativeLocations, admission };
      };
    },
  };
  try {
    await runOpenClawAgentWorkerWrite(options, async () => {
      const written = await execution.runExisting(source, async (worker) => {
        let completed = false;
        try {
          await worker.execute({ type: "trajectory.events.append", input });
          completed = true;
        } finally {
          if (transaction) {
            // Join native settlement before releasing the writer or replaying pending events.
            const outcome = await transaction.retained.settled;
            const receipt = transaction.admission.committed?.facts;
            if (completed || (isRecord(receipt) && receipt.kind === "trajectory-runtime-append")) {
              settle("committed");
            } else if (outcome.kind === "unknown") {
              settle("unknown");
            }
          }
        }
        return true;
      });
      if (!written) {
        throw new Error("Trajectory database disappeared before append");
      }
    });
    void scheduleSqliteTrajectoryRuntimeRetention({
      database,
      options,
      input,
      assertCurrent: assertDatabaseCurrent,
    });
  } finally {
    await execution.release();
  }
}
