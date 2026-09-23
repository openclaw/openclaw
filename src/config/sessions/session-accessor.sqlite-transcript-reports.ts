import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  runOpenClawAgentWriteTransaction,
  withOpenClawAgentDatabaseAsync,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import {
  captureLifecycleDatabaseScope,
  resolveSqliteTranscriptScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { prepareTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendSelectedTranscriptReportInTransaction,
  prepareCustomTranscriptReport,
  prepareTranscriptReportSelection,
  type CustomMessageReport,
  type TranscriptReport,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  TranscriptReportWorkerOperations,
  TranscriptReportWorkerTarget,
} from "./session-accessor.sqlite-transcript-reports.worker.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { startSessionTranscriptIndexReconcile } from "./session-transcript-reconcile.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import {
  assertOwnedTranscriptWriteCommit,
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

const log = createSubsystemLogger("sessions/transcript-reports");

async function settleReportOperation<T>(
  operation: () => Promise<T>,
  cleanup: () => Promise<void>,
): Promise<T> {
  let result: Result<T, unknown>;
  try {
    result = ok(await operation());
  } catch (error) {
    result = err(error);
  }
  try {
    await cleanup();
  } catch (error) {
    if (!result.ok) {
      throw createSqliteLifecycleAggregateError(
        [result.error, error],
        "Transcript report and cleanup failed",
        result.error,
      );
    }
    try {
      log.warn(`Transcript report completed before cleanup failed: ${formatErrorMessage(error)}`);
    } catch {
      // Diagnostics cannot replace a committed result with a replayable failure.
    }
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
}

async function withNativeCurrentTranscript<T>(
  scope: SessionTranscriptWriteScope,
  run: (database: OpenClawAgentDatabase, resolved: ResolvedTranscriptScope) => T,
): Promise<Result<T, TranscriptAppendRefusal>> {
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const resolved = resolveSqliteTranscriptScope(fenced);
  return runExclusiveSqliteSessionWrite(
    resolved,
    async () =>
      runOpenClawAgentWriteTransaction(
        (database) => {
          assertOwnedTranscriptWriteCommit(fenced);
          const refusal = resolveTranscriptAppendRefusal(
            readSessionEntryRow(database, resolved.sessionKey, "list")?.entry,
            resolved,
            fenced,
          );
          if (refusal) {
            if (fenced.expectedWriterRunId !== undefined) {
              throw new SessionTranscriptWriterClaimReboundError(refusal);
            }
            return err(refusal);
          }
          const result = run(database, resolved);
          assertOwnedTranscriptWriteCommit(fenced);
          const rebound = resolveTranscriptAppendRefusal(
            readSessionEntryRow(database, resolved.sessionKey, "list")?.entry,
            resolved,
            fenced,
          );
          if (rebound) {
            throw new SessionTranscriptWriterClaimReboundError(rebound);
          }
          return ok(result);
        },
        toDatabaseOptions(resolved),
        { operationLabel: "session.transcript.report" },
      ),
    "session.transcript.report",
  );
}

async function withReportWorker<T>(
  scope: SessionTranscriptWriteScope,
  run: (
    operation: Pick<SqliteWorkerStore<TranscriptReportWorkerOperations>, "execute">,
    assertCurrent: () => void,
    publish: (result: { projectionNeedsReconcile: boolean }) => void,
  ) => Promise<Result<T, TranscriptAppendRefusal>>,
): Promise<Result<T, TranscriptAppendRefusal>> {
  // Preserve the logical target for live authority and pin the physical owner before yielding.
  const fenced = withOwnedSessionTranscriptWriterFence(scope);
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  const resolved = captureLifecycleDatabaseScope(resolveSqliteTranscriptScope(fenced));
  const options = toDatabaseOptions(resolved);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const assertCurrent = () => {
    execution.assertCurrent();
    assertOwned();
  };
  const { env: _env, ...workerResolved } = resolved;
  const target: TranscriptReportWorkerTarget = {
    resolved: workerResolved,
    fence: {
      expectedLifecycleRevision: fenced.expectedLifecycleRevision,
      expectedWriterRunId: fenced.expectedWriterRunId,
    },
  };
  try {
    const result = await settleReportOperation(
      () =>
        runExclusiveSqliteSessionWrite(
          resolved,
          () =>
            withOpenClawAgentDatabaseAsync(
              options,
              async (database) => {
                assertCurrent();
                const worker =
                  await openOpenClawAgentSqliteWorkerStore<TranscriptReportWorkerOperations>(
                    options,
                    database.db,
                    {
                      moduleUrl: resolveRuntimeWorkerUrl(
                        runtimeProcessEntrypoints.sessionTranscriptReports,
                      ),
                      input: target,
                    },
                  );
                return settleReportOperation(
                  () =>
                    worker.run(
                      (operation) =>
                        run(operation, assertCurrent, (publication) => {
                          if (publication.projectionNeedsReconcile) {
                            startSessionTranscriptIndexReconcile({
                              ...options,
                              preferredSessionId: resolved.sessionId,
                            });
                          }
                        }),
                      assertCurrent,
                    ),
                  () => worker.close(),
                );
              },
              assertCurrent,
            ),
          "session.transcript.report",
        ),
      () => execution.release(),
    );
    if (!result.ok && fenced.expectedWriterRunId !== undefined) {
      throw new SessionTranscriptWriterClaimReboundError(result.error);
    }
    return result;
  } catch (error) {
    // Preserve the stored-JSON error contract across the broker serialization boundary.
    if (error instanceof Error && error.name === "SyntaxError") {
      throw new SyntaxError(error.message, { cause: error });
    }
    throw error;
  }
}

function isProcessHeldTranscript(scope: SessionTranscriptWriteScope): boolean {
  const resolved = captureLifecycleDatabaseScope(resolveSqliteTranscriptScope(scope));
  return isIncognitoOpenClawAgentSqlitePath(
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolved)),
    toDatabaseOptions(resolved),
  );
}

/** Reads the latest matching custom report from the active branch in one snapshot. */
export async function readLatestSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  customTypes: readonly string[],
): Promise<Result<CustomMessageReport | undefined, TranscriptAppendRefusal>> {
  if (isProcessHeldTranscript(scope)) {
    // Process-held incognito databases retain their sole native owner.
    return withNativeCurrentTranscript(
      scope,
      (database, resolved) =>
        prepareTranscriptReportSelection(database, resolved, { kind: "custom", customTypes })
          .latest,
    );
  }
  return withReportWorker(scope, async (operation, assertCurrent) => {
    const prepared = await operation.execute({
      type: "prepare",
      input: { kind: "custom", customTypes },
    });
    assertCurrent();
    return prepared.ok ? ok(prepared.value.latest) : prepared;
  });
}

/** Boot repair and process-held incognito databases retain their native transaction owner. */
export async function appendSessionTranscriptReportNative(
  scope: SessionTranscriptWriteScope,
  report: TranscriptReport,
): Promise<Result<void, TranscriptAppendRefusal>> {
  return withNativeCurrentTranscript(scope, (database, resolved) => {
    const facts = prepareTranscriptReportSelection(
      database,
      resolved,
      report.kind === "assistant"
        ? { kind: "assistant", responseId: report.message.responseId }
        : report,
    );
    if (facts.suppressed) {
      return;
    }
    if (report.kind === "assistant") {
      appendSelectedTranscriptReportInTransaction(database, resolved, facts.appendParentId, report);
      return;
    }
    const selected = report.selectReport(facts.latest);
    if (selected) {
      appendSelectedTranscriptReportInTransaction(
        database,
        resolved,
        facts.appendParentId,
        prepareCustomTranscriptReport(selected, facts.appendParentId),
      );
    }
  });
}

/** Selects and appends one report against the same authoritative branch revision. */
export async function appendSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  report: TranscriptReport,
): Promise<Result<void, TranscriptAppendRefusal>> {
  if (isProcessHeldTranscript(scope)) {
    return appendSessionTranscriptReportNative(scope, report);
  }
  if (report.kind === "assistant") {
    const preparedMessage = prepareTranscriptMessageAppend({
      message: applyAssistantDeliveryDirectives(report.message),
    });
    if (!preparedMessage) {
      throw new Error("Assistant report requires prepared transcript storage bytes");
    }
    const input = { ...report, message: preparedMessage.persistedMessage, preparedMessage };
    return withReportWorker(scope, async (operation, _assertCurrent, publish) => {
      const result = await operation.execute({ type: "assistant", input });
      if (!result.ok) {
        return result;
      }
      publish(result.value);
      return ok(undefined);
    });
  }
  const selection = {
    kind: report.kind,
    customTypes: [...report.customTypes],
    suppressWhenAssistantRun: report.suppressWhenAssistantRun,
  };
  const selectReport = report.selectReport;
  return withReportWorker(scope, async (operation, assertCurrent, publish) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const prepared = await operation.execute({ type: "prepare", input: selection });
      assertCurrent();
      if (!prepared.ok) {
        return prepared;
      }
      if (prepared.value.suppressed) {
        return ok(undefined);
      }
      const selected = selectReport(prepared.value.latest);
      assertCurrent();
      if (!selected) {
        return ok(undefined);
      }
      const input = prepareCustomTranscriptReport(selected, prepared.value.appendParentId);
      assertCurrent();
      const result = await operation.execute({ type: "append", input });
      if (!result.ok) {
        return result;
      }
      if (result.value.committed) {
        publish(result.value);
        return ok(undefined);
      }
      // Only a proven no-write revision mismatch permits another selection; errors never replay.
    }
    throw new Error("Session transcript kept changing while selecting its report");
  });
}
