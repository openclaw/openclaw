// Sanctioned low-level scope/Kysely entry point for doctor, migrations, and infrastructure.
// Runtime feature code imports the session accessor barrel instead of this module.
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { withSqliteReaderOwner } from "../../infra/sqlite-reader-lifecycle.js";
import { getChildLogger } from "../../logging/logger.js";
import { normalizeAgentId } from "../../routing/session-key.js";
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
  runOpenClawAgentWorkerWrite,
  runOpenClawAgentWriteAdmission,
} from "../../state/openclaw-agent-write-admission.js";
import { cloneEnvWithPlatformSemantics } from "../config-env-vars.js";
import { resolveStateDir } from "../paths.js";
import { formatSqliteSessionFileMarker } from "./legacy-sqlite-marker.js";
import { resolveSessionArtifactDirectory } from "./paths.js";
import type {
  SessionTranscriptWriteScope,
  SqliteSessionArtifactPreparationDiagnostics,
  SqliteSessionDatabaseAdmissionDiagnostics,
  SqliteSessionWriteDiagnostics,
} from "./session-accessor.sqlite-contract.js";
import {
  prepareSqliteScopeTarget,
  resolveSqliteDatabaseScopeIdentity,
  resolveSqliteScope,
  type SqliteScopeInput,
} from "./session-accessor.sqlite-read-scope.js";
import {
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
  type ResolvedSqliteScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";
import type { SqliteSessionWriteOperation } from "./session-accessor.sqlite-write-operation.js";
import type { SessionEntryReadSource } from "./session-entry-read-source.types.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "./session-sqlite-target-paths.js";
import type { ResolvedSqliteStoreTarget } from "./session-sqlite-target.js";
import type { InternalSessionEntry } from "./types.js";

export {
  getSessionKysely,
  resolveSqliteAgentId,
  resolveSqliteSessionKey,
  toDatabaseOptions,
  type ResolvedSqliteReadScope,
  type ResolvedSqliteScope,
  type ResolvedTranscriptReadScope,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope-helpers.js";

export {
  prepareSqliteScope,
  prepareSqliteTranscriptReadScope,
  resolveSqliteReadScope,
  resolveSqliteScope,
  resolveSqliteStoreScope,
  resolveSqliteTranscriptReadScope,
  type SessionSqliteTargetResolutionCache,
} from "./session-accessor.sqlite-read-scope.js";

const SQLITE_SESSION_SLOW_WRITE_MS = 1_000;
const SQLITE_SESSION_WRITE_ERROR_MAX_CHARS = 2_048;
const sessionWriteDiagnostics = channel("openclaw.session.write");

/** Checks the freshly read identity and lifecycle before a synchronous transcript mutation. */
export function transcriptWriteScopeIsCurrent(
  entry:
    | Pick<InternalSessionEntry, "sessionId" | "activeWriterRunId" | "lifecycleRevision">
    | undefined,
  sessionId: string,
  scope: SessionTranscriptWriteScope,
): boolean {
  return (
    entry !== undefined &&
    entry.sessionId === sessionId &&
    (scope.expectedOwner === undefined ||
      (entry.lifecycleRevision === scope.expectedOwner.lifecycleRevision &&
        entry.activeWriterRunId === scope.expectedOwner.activeWriterRunId)) &&
    (scope.expectedLifecycleRevision === undefined ||
      entry.lifecycleRevision === scope.expectedLifecycleRevision) &&
    (scope.expectedWriterRunId === undefined ||
      entry.activeWriterRunId === scope.expectedWriterRunId)
  );
}

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

export function resolveSqliteTranscriptArchiveDirectory(
  scope: Pick<ResolvedSqliteReadScope, "agentId" | "env" | "ownerStorePath" | "path">,
): string {
  // Pinning the native database must not move artifacts away from its configured selector.
  const storePath =
    scope.ownerStorePath ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope));
  return resolveSessionArtifactDirectory(storePath);
}

/** Validate prepared write identity without resolving or reopening its physical target. */
export function assertSqliteTranscriptWriteIdentity<
  T extends Pick<SessionTranscriptWriteScope, "sessionId" | "sessionKey">,
>(scope: T): asserts scope is T & { sessionId: string; sessionKey: string } {
  if (typeof scope.sessionId !== "string" || !scope.sessionId) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session id: ${scope.sessionKey}`,
    );
  }
  if (typeof scope.sessionKey !== "string" || !scope.sessionKey) {
    throw new Error(
      `Cannot resolve SQLite transcript scope without a session key: ${scope.sessionId}`,
    );
  }
}

export function resolveSqliteTranscriptScope(
  scope: Pick<
    SessionTranscriptWriteScope,
    "agentId" | "env" | "sessionId" | "sessionKey" | "storePath"
  >,
  readSource?: SessionEntryReadSource,
): ResolvedTranscriptScope {
  assertSqliteTranscriptWriteIdentity(scope);
  return {
    ...resolveSqliteScope(
      { ...scope, sessionKey: scope.sessionKey },
      undefined,
      readSource ? { ...readSource, shared: true } : undefined,
    ),
    sessionId: scope.sessionId,
  };
}

/** Exact locators can reserve their FIFO before worker-owned schema-owner discovery. */
export function resolveSqliteWriteAdmissionScope(
  scope: SqliteScopeInput & { sessionKey: string },
): (ResolvedSqliteReadScope & { path: string; shared?: boolean }) | undefined {
  const { effectiveAgentId, effectiveStorePath, effectiveEnv, explicitIncognito } =
    resolveSqliteDatabaseScopeIdentity(scope);
  const target: ResolvedSqliteStoreTarget | undefined = effectiveStorePath
    ? (explicitIncognito ?? resolveUnsuffixedSqliteTargetFromSessionStorePath(effectiveStorePath))
    : undefined;
  // Custom logical stores may select a persisted suffix; do not reserve the wrong file.
  if (target && !target.agentId && !target.shared) {
    return undefined;
  }
  // This names only the physical queue, not schema authority. Worker preparation
  // supplies the actual logical and database owners before reading or committing.
  const agentId = effectiveAgentId ?? target?.agentId ?? normalizeAgentId(scope.defaultAgentId);
  return {
    agentId,
    env: effectiveEnv,
    path: target?.path ?? resolveOpenClawAgentSqlitePath({ agentId, env: effectiveEnv }),
    ...(target?.shared ? { shared: true } : {}),
  };
}

/** Canonical writers must enter their existing FIFO before the first asynchronous yield. */
export function withPreparedSqliteScope<T>(
  scope: SqliteScopeInput & { sessionKey: string },
  run: (resolved: ResolvedSqliteScope) => T | Promise<T>,
  signal?: AbortSignal,
): T | Promise<T> {
  signal?.throwIfAborted();
  const env = cloneEnvWithPlatformSemantics(scope.env ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const captured = { ...scope, env };
  if (!isMainThread) {
    return run(resolveSqliteScope(captured));
  }
  const { effectiveStorePath, explicitIncognito } = resolveSqliteDatabaseScopeIdentity(captured);
  const target = effectiveStorePath
    ? (explicitIncognito ?? resolveUnsuffixedSqliteTargetFromSessionStorePath(effectiveStorePath))
    : undefined;
  if (!effectiveStorePath || target?.agentId) {
    return run(resolveSqliteScope(captured, undefined, target));
  }
  // Shared and custom locators need worker-owned discovery; the resolved writer owns admission.
  return prepareSqliteScopeTarget(captured, signal).then((prepared) =>
    run(resolveSqliteScope(captured, undefined, prepared)),
  );
}

/** Pin the environment and database locator before lifecycle work yields. */
export function captureLifecycleDatabaseScope<T extends ResolvedSqliteReadScope>(
  scope: T,
): T & { env: NodeJS.ProcessEnv; path: string } {
  const env = { ...(scope.env ?? process.env) };
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  return {
    ...scope,
    env,
    path: resolveOpenClawAgentSqlitePath(toDatabaseOptions({ ...scope, env })),
  };
}

/** Legacy identity string retained only for transcript artifact metadata and plugin contracts. */
export function formatLegacySqliteSessionMarkerForScope(scope: ResolvedTranscriptScope): string {
  return formatSqliteSessionFileMarker({
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    storePath: scope.path ?? resolveOpenClawAgentSqlitePath(toDatabaseOptions(scope)),
  });
}
