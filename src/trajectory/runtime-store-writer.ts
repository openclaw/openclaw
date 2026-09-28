import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  loadSessionEntry,
  type SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
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
  withOpenClawAgentDatabaseAsync,
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
import {
  appendSqliteTrajectoryRuntimeEvents,
  type SqliteTrajectoryRuntimeAppend,
} from "./runtime-store.sqlite.js";
import type { TrajectoryEvent } from "./types.js";

export function createSqliteTrajectoryRuntimeSink(params: {
  env: NodeJS.ProcessEnv;
  maxRuntimeFileBytes: number;
  sessionFile?: string;
  sessionId: string;
  sessionKey?: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  assertCommitAllowed?: () => void;
}): {
  describeFlushState(): string | undefined;
  flush(): Promise<void>;
  write(event: TrajectoryEvent, line: string): void;
} | null {
  const target = params.sessionTarget
    ? {
        agentId: normalizeOptionalString(params.sessionTarget.agentId),
        sessionId: normalizeOptionalString(params.sessionTarget.sessionId),
        sessionKey: normalizeOptionalString(params.sessionTarget.sessionKey),
        storePath: normalizeOptionalString(params.sessionTarget.storePath),
      }
    : undefined;
  const legacyMarker = parseSqliteSessionFileMarker(params.sessionFile);
  const completeTarget = Boolean(
    target?.agentId && target.sessionId && target.sessionKey && target.storePath,
  );
  const targetKeyAgentId = parseAgentSessionKey(target?.sessionKey)?.agentId;
  const requestedSessionKey = normalizeOptionalString(params.sessionKey);
  const completeTargetKeyEntry =
    completeTarget && target?.agentId && target.sessionKey && target.storePath
      ? loadSessionEntry({
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
      ? loadSessionEntry({
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
  const databaseOptions = toDatabaseOptions(resolveSqliteReadScope({ ...marker, env }));
  const pendingEvents: TrajectoryEvent[] = [];
  let queuedBytes = 0;
  let unsettledAppend: SqliteWorkerError | undefined;
  return {
    describeFlushState: () =>
      pendingEvents.length > 0
        ? `pendingRows=${pendingEvents.length} queuedBytes=${queuedBytes} activeOperation=sqlite-append`
        : undefined,
    flush: async () => {
      if (unsettledAppend) {
        throw unsettledAppend;
      }
      if (pendingEvents.length === 0) {
        return;
      }
      await runOpenClawAgentWriteAdmission(
        databaseOptions,
        async () => {
          if (unsettledAppend) {
            throw unsettledAppend;
          }
          if (pendingEvents.length === 0) {
            return;
          }
          await withOpenClawAgentDatabaseAsync(databaseOptions, async (database) => {
            // Capture the prefix inside the FIFO turn; new events remain queued during the write.
            const events = pendingEvents.slice();
            const bytes = queuedBytes;
            const retire = () => {
              pendingEvents.splice(0, events.length);
              queuedBytes -= bytes;
            };
            if (isMainThread && supportsOpenClawAgentDatabaseExecution(databaseOptions)) {
              await appendSqliteTrajectoryRuntimeEventsInWorker(
                databaseOptions,
                database,
                {
                  events,
                  maxRuntimeBytes: params.maxRuntimeFileBytes,
                  sessionId: marker.sessionId,
                },
                params.assertCommitAllowed,
                (outcome) => {
                  if (outcome === "committed") {
                    retire();
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
                  env: databaseOptions.env,
                  maxRuntimeBytes: params.maxRuntimeFileBytes,
                  sessionId: marker.sessionId,
                  storePath: database.path,
                  assertCommitAllowed: params.assertCommitAllowed,
                },
                events,
              );
              retire();
            }
          });
        },
        true,
      );
    },
    write: (event, line) => {
      pendingEvents.push(event);
      queuedBytes += Buffer.byteLength(line, "utf8") + 1;
    },
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
  const assertCurrent = () => {
    execution.assertCurrent();
    // The source guard can read session metadata; retain its admitted host handle.
    if (!database.db.isOpen || getOpenClawAgentDatabaseIfOpen(options)?.db !== database.db) {
      throw new Error("Trajectory append lost its borrowed database owner");
    }
    assertCommitAllowed?.();
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
  } finally {
    await execution.release();
  }
}
