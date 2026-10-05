import path from "node:path";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../../infra/errors.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../../infra/sqlite-worker-identity.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-store.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isIncognitoSessionKey, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { attachSessionTranscriptRunId } from "../../sessions/transcript-events.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  isIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { cliHistoryWriterFacts, getCliHistoryWriter } from "./cli-history-boundary.js";
import type {
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
} from "./session-accessor.sqlite-contract.js";
import { publishSessionEntryWorkerMetadataInvalidation } from "./session-accessor.sqlite-entry-cache.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { publishTranscriptUpdate } from "./session-accessor.sqlite-events.js";
import { prepareSessionEntryReplacementDatabase } from "./session-accessor.sqlite-replacement-worker.js";
import {
  captureLifecycleDatabaseScope,
  assertSqliteTranscriptWriteIdentity,
  prepareSqliteScope,
  resolveSqliteScope,
  resolveSqliteTranscriptScope,
  resolveSqliteWriteAdmissionScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
  type ResolvedTranscriptScope,
} from "./session-accessor.sqlite-scope.js";
import { prepareTranscriptMessageAppend } from "./session-accessor.sqlite-transcript-message-append.js";
import {
  appendAbortedSessionTranscriptPartialInTransaction,
  appendSelectedTranscriptReportInTransaction,
  prepareCustomTranscriptReport,
  prepareTranscriptReportSelection,
} from "./session-accessor.sqlite-transcript-reports.kernel.js";
import type {
  CustomMessageReport,
  AbortedSessionTranscriptPartial,
  AbortedSessionTranscriptPartialResult,
  TranscriptReport,
  TranscriptReportWorkerOperations,
} from "./session-accessor.sqlite-transcript-reports.types.js";
import type { TranscriptReportWorkerTarget } from "./session-accessor.sqlite-transcript-reports.worker.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { assertSessionEntryCurrentAdmission } from "./session-entry-current-admission.js";
import type { SessionEntryCurrentCheck } from "./session-entry-current.types.js";
import type { IncognitoSessionAuthority } from "./session-incognito-contract.js";
import type { IncognitoTranscriptOperations } from "./session-incognito-transcript-contract.js";
import {
  assertSessionStoreReadCandidate,
  captureSessionStoreCandidateIdentities,
} from "./session-store-read-candidates.js";
import { captureSessionStoreReadCandidates } from "./session-store-target-inventory.js";
import {
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import { applyAssistantDeliveryDirectives } from "./transcript-assistant-delivery.js";
import { captureSessionTranscriptStorageEnvironment } from "./transcript-target-binding.js";
import {
  assertOwnedTranscriptWriteCommit,
  captureOwnedTranscriptWriteAssertion,
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWriterFence,
} from "./transcript-write-context.js";

const log = createSubsystemLogger("sessions/transcript-reports");

export type IncognitoTranscriptReportBinding = {
  actor: IncognitoAgentDatabaseExecution;
  authority: IncognitoSessionAuthority;
};

/** Inactive composition: routing must supply the already captured actor at activation. */
function withIncognitoReportWorker<T>(
  scope: SessionTranscriptWriteScope,
  binding: IncognitoTranscriptReportBinding,
  run: Parameters<typeof withReportWorker<T>>[2],
): Promise<Result<T, TranscriptAppendRefusal>> {
  const { actor, authority: source } = binding;
  const fenced = withOwnedSessionTranscriptWriterFence({
    ...scope,
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  });
  assertSqliteTranscriptWriteIdentity(fenced);
  if (!isIncognitoSessionKey(fenced.sessionKey)) {
    throw new Error("An incognito report requires an incognito session key");
  }
  const resolved = resolveSqliteTranscriptScope(fenced);
  if (resolved.agentId !== actor.agentId || resolved.path !== actor.path) {
    throw new Error("Transcript report differs from its retained incognito actor");
  }
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  const assertCurrent = () => {
    actor.assertCurrent();
    source.assertCurrent();
    assertOwned();
  };
  assertCurrent();
  const authority: IncognitoSessionAuthority = {
    assertCurrent,
    authorize: (stage, facts) => source.authorize?.(stage, facts),
  };
  const target = {
    sessionKey: resolved.sessionKey,
    sessionId: resolved.sessionId,
    fence: {
      expectedLifecycleRevision: fenced.expectedLifecycleRevision,
      expectedWriterRunId: fenced.expectedWriterRunId,
    },
  };
  return actor.sessions.withSharedState(async () => {
    let prepared:
      | IncognitoTranscriptOperations["session.report.append"]["input"]["prepared"]
      | undefined;
    let reconcile = false;
    const commands: {
      [Key in keyof TranscriptReportWorkerOperations]: (
        input: TranscriptReportWorkerOperations[Key]["input"],
      ) => Promise<TranscriptReportWorkerOperations[Key]["output"]>;
    } = {
      prepare: async (selection) => {
        prepared = undefined;
        const result = await actor.sessions.transcript(authority, {
          type: "session.report.prepare",
          input: { ...target, selection },
        });
        if (!result.ok) {
          return result;
        }
        prepared = result.value.prepared;
        return ok(result.value.facts);
      },
      append: (report) => {
        if (!prepared) {
          throw new Error("Incognito report append requires its prepared selection");
        }
        return actor.sessions.transcript(authority, {
          type: "session.report.append",
          input: { ...target, prepared, report },
        });
      },
      assistant: (report) =>
        actor.sessions.transcript(authority, {
          type: "session.report.assistant",
          input: { ...target, report },
        }),
      abortedPartial: (report) =>
        actor.sessions.transcript(authority, {
          type: "session.report.abortedPartial",
          input: { ...target, report },
        }),
    };
    const result = await settleReportOperation(
      () =>
        run(
          { execute: ({ type, input }) => commands[type](input) },
          assertCurrent,
          (publication) => {
            // The actor installs committed entry facts before returning its receipt.
            reconcile ||= publication.projectionNeedsReconcile;
          },
        ),
      async () => {
        if (reconcile) {
          await reconcileSessionTranscriptIndexes(
            {
              agentId: actor.agentId,
              path: actor.path,
              env: fenced.env,
              preferredSessionId: target.sessionId,
            },
            {
              actor,
              authority,
              target: { ...target, lifecycleRevision: fenced.expectedLifecycleRevision },
            },
          );
        }
      },
    );
    if (!result.ok && fenced.expectedWriterRunId !== undefined) {
      throw new SessionTranscriptWriterClaimReboundError(result.error);
    }
    return result;
  });
}

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
  kind: "read" | "append",
  run: (
    operation: Pick<SqliteWorkerStore<TranscriptReportWorkerOperations>, "execute">,
    assertCurrent: () => void,
    publish: (result: {
      projectionNeedsReconcile: boolean;
      cliHistoryChanged?: boolean;
      sessionEntryChanged?: boolean;
    }) => void,
  ) => Promise<Result<T, TranscriptAppendRefusal>>,
  sessionEntryCurrent?: SessionEntryCurrentCheck,
  incognito?: IncognitoTranscriptReportBinding,
): Promise<Result<T, TranscriptAppendRefusal>> {
  if (incognito) {
    if (sessionEntryCurrent) {
      throw new Error("A file session source cannot authorize an incognito transcript report");
    }
    try {
      return await withIncognitoReportWorker(scope, incognito, run);
    } catch (error) {
      if (error instanceof Error && error.name === "SyntaxError") {
        throw new SyntaxError(error.message, { cause: error });
      }
      throw error;
    }
  }
  // Preserve the logical target for live authority and pin the physical owner before yielding.
  const fenced = withOwnedSessionTranscriptWriterFence({
    ...scope,
    ...(scope.storePath ? { storePath: path.resolve(scope.storePath) } : {}),
    env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env),
  });
  const assertOwned = captureOwnedTranscriptWriteAssertion(fenced);
  assertSqliteTranscriptWriteIdentity(fenced);
  assertOwned();
  const source = sessionEntryCurrent?.source;
  const storePath =
    fenced.storePath ??
    resolveOpenClawAgentSqlitePath(toDatabaseOptions(resolveSqliteScope(fenced)));
  const candidates = captureSessionStoreReadCandidates(storePath);
  const identities = captureSessionStoreCandidateIdentities(candidates);
  const sourceIdentity = source ? readDatabasePathIdentitySync(source.path) : undefined;
  const assertSourceCurrent = () => {
    if (!source) {
      return;
    }
    assertExistingDatabaseIdentity(
      source.path,
      `file:${source.databaseIdentity}`,
      source.databaseBirthtime,
    );
  };
  assertSourceCurrent();
  const targetScope = { ...fenced, storePath };
  const admission = resolveSqliteWriteAdmissionScope(targetScope);
  const prepare = async () => {
    const resolved = captureLifecycleDatabaseScope({
      ...(await prepareSqliteScope(targetScope)),
      sessionId: fenced.sessionId,
    });
    if (admission && resolved.path !== admission.path) {
      throw new Error("Transcript report preparation changed its reserved database path");
    }
    const databaseOptions = toDatabaseOptions(resolved);
    const options = { ...databaseOptions, path: resolveOpenClawAgentSqlitePath(databaseOptions) };
    const physicalPath = assertSessionStoreReadCandidate(options.path, candidates);
    if (
      source &&
      (resolved.sessionKey !== source.sessionKey ||
        databaseOptions.agentId !== source.agentId ||
        physicalPath !== sourceIdentity?.canonicalPath)
    ) {
      throw new Error("Transcript report target differs from its session source restriction");
    }
    const identity = identities.get(physicalPath) ?? readDatabasePathIdentitySync(options.path);
    if (!identities.has(physicalPath) && identity.key.startsWith("file:")) {
      throw new Error("Transcript report target appeared after source capture");
    }
    const assertTargetCurrent = () => {
      assertSourceCurrent();
      assertSessionStoreReadCandidate(options.path, candidates);
      if (identity.key.startsWith("file:")) {
        assertExistingDatabaseIdentity(options.path, identity.key, identity.birthtime);
      }
      assertOwned();
    };
    assertTargetCurrent();
    const operate = async () => {
      assertTargetCurrent();
      const execution = captureOpenClawAgentDatabaseExecution(
        options,
        identity.key.startsWith("file:")
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: identity.key.slice("file:".length),
                nativeLocation: identity.canonicalPath,
                birthtime: identity.birthtime,
              },
            }
          : { expectedCreationIdentity: identity },
      );
      const cliWriter =
        kind === "append"
          ? getCliHistoryWriter({ ...resolved, storePath: resolveOpenClawAgentSqlitePath(options) })
          : undefined;
      const assertCurrent = () => {
        execution.assertCurrent();
        assertTargetCurrent();
        cliWriter?.assertCurrent();
      };
      const { env: _env, ...workerResolved } = resolved;
      try {
        const result = await settleReportOperation(
          async () => {
            await prepareSessionEntryReplacementDatabase(options, assertCurrent, execution);
            assertCurrent();
            const target: TranscriptReportWorkerTarget = {
              resolved: workerResolved,
              sessionEntryCurrentSource: sessionEntryCurrent?.source,
              // Account facts only: each write confirms the owner as it is sent, below.
              ...(cliWriter ? { cliWriter: cliHistoryWriterFacts(cliWriter) } : {}),
              fence: {
                expectedLifecycleRevision: fenced.expectedLifecycleRevision,
                expectedWriterRunId: fenced.expectedWriterRunId,
              },
            };
            const databaseIdentity = execution.fileIdentity?.physicalIdentity;
            if (!databaseIdentity) {
              throw new Error("Transcript report has no prepared native database identity");
            }
            const worker =
              await openOpenClawAgentSqliteWorkerStore<TranscriptReportWorkerOperations>(
                options,
                { execution },
                {
                  moduleUrl: resolveRuntimeWorkerUrl(
                    runtimeProcessEntrypoints.sessionTranscriptReports,
                  ),
                  input: target,
                  assertAdmission: (request) =>
                    request.stage === "transaction" || request.stage === "commit"
                      ? assertSessionEntryCurrentAdmission(request, sessionEntryCurrent)
                      : request,
                },
              );
            return settleReportOperation(
              () =>
                worker.run(
                  (operation) =>
                    run(
                      cliWriter
                        ? {
                            // Confirm the owner as the last host step before each write.
                            execute: (command, executeOptions) =>
                              operation.execute(
                                command.type === "prepare"
                                  ? command
                                  : {
                                      ...command,
                                      input: {
                                        ...command.input,
                                        cliHistoryOwnerConfirmed:
                                          cliWriter.confirmsOwner?.() !== false,
                                      },
                                    },
                                executeOptions,
                              ),
                          }
                        : operation,
                      assertCurrent,
                      (publication) => {
                        if (publication.cliHistoryChanged || publication.sessionEntryChanged) {
                          publishSessionEntryWorkerMetadataInvalidation({
                            agentId: resolved.agentId,
                            storePath: execution.path,
                            databaseIdentity,
                            sessionKey: resolved.sessionKey,
                          });
                        }
                        if (publication.projectionNeedsReconcile) {
                          startSessionTranscriptIndexReconcile({
                            ...options,
                            preferredSessionId: resolved.sessionId,
                          });
                        }
                      },
                    ),
                  assertCurrent,
                ),
              () => worker.close(),
            );
          },
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
    };
    return admission
      ? operate()
      : runExclusiveSqliteSessionWrite(resolved, operate, "session.transcript.report");
  };
  return admission
    ? runExclusiveSqliteSessionWrite(admission, prepare, "session.transcript.report")
    : prepare();
}

function isProcessHeldTranscript(scope: SessionTranscriptWriteScope): boolean {
  return (
    isIncognitoSessionKey(scope.sessionKey) ||
    Boolean(
      scope.storePath &&
      isIncognitoOpenClawAgentSqlitePath(scope.storePath, {
        agentId: scope.agentId ?? resolveAgentIdFromSessionKey(scope.sessionKey),
        env: scope.env,
      }),
    )
  );
}

/** Fills a hot transcript only when its settled registered producer left no authoritative answer. */
export async function appendAbortedSessionTranscriptPartial(
  scope: SessionTranscriptWriteScope & { sessionId: string },
  partial: AbortedSessionTranscriptPartial & {
    config?: import("../types.openclaw.js").OpenClawConfig;
  },
  incognito?: IncognitoTranscriptReportBinding,
): Promise<Result<AbortedSessionTranscriptPartialResult, TranscriptAppendRefusal>> {
  const publicationScope = {
    ...scope,
    ...(incognito
      ? { env: captureSessionTranscriptStorageEnvironment(scope.env ?? process.env) }
      : {}),
  };
  const { config, ...input } = partial;
  const preparedMessage = prepareTranscriptMessageAppend({
    message: attachSessionTranscriptRunId(partial.message, partial.runId),
    config,
  });
  if (!preparedMessage || preparedMessage.persistedMessage.role !== "assistant") {
    throw new Error("Aborted partial requires prepared assistant storage bytes");
  }
  const settlement =
    !incognito && isProcessHeldTranscript(publicationScope)
      ? await withNativeCurrentTranscript(publicationScope, (database, resolved) =>
          appendAbortedSessionTranscriptPartialInTransaction(
            database,
            resolved,
            input,
            preparedMessage,
          ),
        )
      : await withReportWorker(
          publicationScope,
          "append",
          async (operation, _assertCurrent, publish) => {
            const result = await operation.execute({
              type: "abortedPartial",
              input: { ...input, message: preparedMessage.persistedMessage, preparedMessage },
            });
            if (!result.ok) {
              return result;
            }
            const receipt = result.value.abortedPartial;
            if (!receipt) {
              throw new Error("Aborted partial worker returned no settlement receipt");
            }
            publish(result.value);
            return ok(receipt);
          },
          undefined,
          incognito,
        );
  if (settlement.ok && !settlement.value.skipped && settlement.value.append.appended) {
    const { append, lifecycleRevision, messageSeq } = settlement.value;
    await publishTranscriptUpdate(publicationScope, {
      lifecycleRevision,
      messageSeq,
      message: append.message,
      messageId: append.messageId,
      runId: input.runId,
    });
  }
  return settlement;
}

/** Reads the latest matching custom report from the active branch in one snapshot. */
export async function readLatestSessionTranscriptReport(
  scope: SessionTranscriptWriteScope,
  customTypes: readonly string[],
  incognito?: IncognitoTranscriptReportBinding,
): Promise<Result<CustomMessageReport | undefined, TranscriptAppendRefusal>> {
  const selectedTypes = [...customTypes];
  if (!incognito && isProcessHeldTranscript(scope)) {
    // Process-held incognito databases retain their sole native owner.
    return withNativeCurrentTranscript(
      scope,
      (database, resolved) =>
        prepareTranscriptReportSelection(database, resolved, {
          kind: "custom",
          customTypes: selectedTypes,
        }).latest,
    );
  }
  return withReportWorker(
    scope,
    "read",
    async (operation, assertCurrent) => {
      const prepared = await operation.execute({
        type: "prepare",
        input: { kind: "custom", customTypes: selectedTypes },
      });
      assertCurrent();
      return prepared.ok ? ok(prepared.value.latest) : prepared;
    },
    undefined,
    incognito,
  );
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
  options?: {
    sessionEntryCurrent?: SessionEntryCurrentCheck;
    incognito?: IncognitoTranscriptReportBinding;
  },
): Promise<Result<void, TranscriptAppendRefusal>> {
  if (!options?.incognito && isProcessHeldTranscript(scope)) {
    if (options?.sessionEntryCurrent) {
      throw new Error("A file session source cannot authorize a process-held transcript report");
    }
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
    return withReportWorker(
      scope,
      "append",
      async (operation, _assertCurrent, publish) => {
        const result = await operation.execute({ type: "assistant", input });
        if (!result.ok) {
          return result;
        }
        publish(result.value);
        return ok(undefined);
      },
      options?.sessionEntryCurrent,
      options?.incognito,
    );
  }
  const selection = {
    kind: report.kind,
    customTypes: [...report.customTypes],
    suppressWhenAssistantRun: report.suppressWhenAssistantRun,
  };
  const selectReport = report.selectReport;
  return withReportWorker(
    scope,
    "append",
    async (operation, assertCurrent, publish) => {
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
    },
    options?.sessionEntryCurrent,
    options?.incognito,
  );
}
