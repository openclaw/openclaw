import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { withSqliteReaderOwner } from "../../infra/sqlite-reader-lifecycle.js";
import { getChildLogger } from "../../logging/logger.js";
import { assertAgentSessionWriteAdmission } from "../../sessions/session-agent-work-admission.js";
import type { StoreWriterTiming } from "../../shared/store-writer-queue.js";
import {
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseRuntime,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  runOpenClawAgentPathWriteAdmission,
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import type {
  SqliteSessionArtifactPreparationDiagnostics,
  SqliteSessionDatabaseAdmissionDiagnostics,
  SqliteSessionWriteDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteWriteAdmissionScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
  withPreparedSqliteScope,
  type ResolvedSqliteScope,
} from "./session-accessor.sqlite-scope.js";
import { readActiveTranscriptEntryAnchorInTransaction } from "./session-accessor.sqlite-transcript-anchor.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import type { TranscriptEntryAnchor } from "./transcript-entry-anchor.js";

/** Direct writes reserve shared paths before discovery; multi-phase writers own their phases. */
export function withPreparedSqliteWriteScope<T>(
  scope: Parameters<typeof withPreparedSqliteScope>[0],
  run: (resolved: ResolvedSqliteScope, sharedWriteReserved: boolean) => T | Promise<T>,
): T | Promise<T> {
  const admission = isMainThread ? resolveSqliteWriteAdmissionScope(scope) : undefined;
  if (!admission?.shared) {
    return withPreparedSqliteScope(scope, (resolved) => run(resolved, false));
  }
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const captured = { ...scope, env };
  return runOpenClawAgentPathWriteAdmission(
    admission.path,
    (_identity, assertCurrent) =>
      withPreparedSqliteScope(captured, (resolved) => {
        assertCurrent();
        return run(resolved, true);
      }),
    true,
  );
}

const SQLITE_SESSION_SLOW_WRITE_MS = 1_000;
const SQLITE_SESSION_WRITE_ERROR_MAX_CHARS = 2_048;
const sessionWriteDiagnostics = channel("openclaw.session.write");

export function withSqliteSessionDatabase<T>(
  options: OpenClawAgentDatabaseOptions,
  operation: (database: OpenClawAgentDatabase) => T,
  assertCurrent?: () => void,
  diagnostics?: SqliteSessionDatabaseAdmissionDiagnostics,
): T | Promise<T> {
  assertCurrent?.();
  const startedAt = diagnostics ? performance.now() : 0;
  const finishAdmission = diagnostics
    ? () => {
        if (diagnostics.admissionMs === undefined) {
          diagnostics.admissionMs = performance.now() - startedAt;
        }
      }
    : undefined;
  const admittedOperation = finishAdmission
    ? (database: OpenClawAgentDatabase) => {
        finishAdmission();
        return operation(database);
      }
    : operation;
  try {
    if (getOpenClawAgentDatabaseIfOpen(options)) {
      if (diagnostics) {
        diagnostics.admissionMode = "cached";
      }
      return admittedOperation(openOpenClawAgentDatabase(options));
    }
    if (diagnostics) {
      diagnostics.admissionMode = "async";
    }
    // The caller keeps its FIFO section while the existing owner joins the integrity child.
    const result = withOpenClawAgentDatabaseRuntime(options, admittedOperation, assertCurrent);
    return finishAdmission ? result.finally(finishAdmission) : result;
  } catch (error) {
    finishAdmission?.();
    throw error;
  }
}

function artifactPreparationLogFields(diagnostics: SqliteSessionArtifactPreparationDiagnostics) {
  const milliseconds = (value: number | undefined) =>
    value === undefined ? undefined : Math.round(value);
  return {
    admissionMode: diagnostics.admissionMode,
    admissionMs: milliseconds(diagnostics.admissionMs),
    nodeInventoryMs: milliseconds(diagnostics.nodeInventoryMs),
    referencePlanningMs: milliseconds(diagnostics.referencePlanningMs),
    orphanPlanningMs: milliseconds(diagnostics.orphanPlanningMs),
    markerScanMs: milliseconds(diagnostics.markerScanMs),
    nodeRows: diagnostics.nodeRows,
    windowRows: diagnostics.windowRows,
    referenceIds: diagnostics.referenceIds,
    selectedEntries: diagnostics.selectedEntries,
    markerWindows: diagnostics.markerWindows,
    markerRows: diagnostics.markerRows,
    deletePlans: diagnostics.deletePlans,
    completed: diagnostics.completed === true,
  };
}

export async function runExclusiveSqliteSessionWrite<T>(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "path">,
  fn: () => Promise<T>,
  operation: SqliteSessionWriteOperation,
  diagnostics?: SqliteSessionWriteDiagnostics,
  writer: "foreground" | "foreground-reentrant" | "worker" = "foreground",
  signal?: AbortSignal,
): Promise<T> {
  const databaseOptions = toDatabaseOptions(scope);
  assertAgentSessionWriteAdmission(databaseOptions, scope.agentId);
  const timing: StoreWriterTiming = {};
  const storePath = resolveOpenClawAgentSqlitePath(databaseOptions);
  const startedAt = performance.now();
  const timingFields = (completedAt: number) => ({
    pid: process.pid,
    threadId,
    isMainThread,
    operation,
    ...(diagnostics?.kind ? { reclamationKind: diagnostics.kind } : {}),
    ...(diagnostics?.workerThreadId !== undefined
      ? { workerThreadId: diagnostics.workerThreadId }
      : {}),
    ...(diagnostics?.artifactPreparation
      ? { artifactPreparation: artifactPreparationLogFields(diagnostics.artifactPreparation) }
      : {}),
    elapsedMs: Math.round(completedAt - startedAt),
    ...(timing.startedAt !== undefined && timing.finishedAt !== undefined
      ? {
          queueWaitMs: Math.round(timing.startedAt - startedAt),
          writerExecutionMs: Math.round(timing.finishedAt - timing.startedAt),
          completionDelayMs: Math.round(completedAt - timing.finishedAt),
          reentrant: timing.reentrant,
        }
      : {}),
  });
  const logFields = (completedAt: number) => ({
    agentId: scope.agentId,
    ...timingFields(completedAt),
    ...(diagnostics?.reclamationAdmission
      ? {
          reclamationAdmissionId: diagnostics.reclamationAdmission.admissionId,
          reclamationAdmissionReleaseCause: diagnostics.reclamationAdmission.releaseCause,
        }
      : {}),
    storePath,
  });
  let completedAt = startedAt;
  let outcome: "ok" | "error" = "ok";
  const admitted = () => {
    assertAgentSessionWriteAdmission(databaseOptions, scope.agentId);
    return fn();
  };
  const owned = () =>
    withSqliteReaderOwner(
      { operation, ownerKind: isMainThread ? "main" : "worker", actorId: threadId },
      () =>
        writer === "worker"
          ? runOpenClawAgentWorkerWrite(databaseOptions, admitted, timing, signal)
          : runOpenClawAgentWriteAdmission(
              databaseOptions,
              admitted,
              writer === "foreground-reentrant",
              timing,
              signal,
            ),
    );
  try {
    const result = await owned();
    completedAt = performance.now();
    if (completedAt - startedAt >= SQLITE_SESSION_SLOW_WRITE_MS) {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        logFields(completedAt),
        "slow SQLite session write",
      );
    }
    return result;
  } catch (error) {
    outcome = "error";
    completedAt = performance.now();
    getChildLogger({ subsystem: "session-sqlite" }).warn(
      {
        ...logFields(completedAt),
        error: truncateUtf16Safe(
          formatErrorMessageWithCode(error),
          SQLITE_SESSION_WRITE_ERROR_MAX_CHARS,
        ),
      },
      "SQLite session write failed",
    );
    throw error;
  } finally {
    if (sessionWriteDiagnostics.hasSubscribers) {
      // Profiling retains fixed owner categories and timings, never database or admission identities.
      sessionWriteDiagnostics.publish({ ...timingFields(completedAt), writer, outcome });
    }
  }
}

/** Reads one active message identity from the authoritative SQLite projection. */
export function readActiveTranscriptEntryAnchor(params: {
  agentId?: string;
  sessionId: string;
  sessionKey: string;
  storePath?: string;
  entryId: string;
}): TranscriptEntryAnchor | undefined {
  const resolved = resolveSqliteTranscriptScope(params);
  const database = openOpenClawAgentDatabase(toDatabaseOptions(resolved));
  return readActiveTranscriptEntryAnchorInTransaction({
    database,
    resolved,
    entryId: params.entryId,
  });
}
