import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import {
  hasSqliteWorkerOutcomeUnknown,
  retainSqliteWorkerErrorCode,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { getChildLogger } from "../../logging/logger.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type {
  AgentDatabaseGenerationClaim,
  AgentDatabaseRequestExecutionSource,
} from "../../state/openclaw-agent-execution-admission-contract.js";
import type {
  AgentDatabaseExecutionScope,
  AgentDatabaseOperations,
  OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type { SessionEntryReplacementCommitted } from "./session-accessor.sqlite-replacement-types.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";
import { withSessionEntryWriterReads } from "./session-entry-read-facts.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import { parseSessionTranscriptAuthorityReceipts } from "./session-transcript-authority.js";

type ReplacementDatabaseOptions = OpenClawAgentDatabaseOptions & { path: string };

export type SessionEntryWorkerPreparation = (
  execution: OpenClawAgentDatabaseExecution,
  source: AgentDatabaseRequestExecutionSource,
) => {
  prepare: () => Promise<void>;
  beforeWrite: () => void;
  release: () => Promise<void>;
};

function rejectUnknownSessionEntryOutcome(message: string, cause: unknown): never {
  if (hasSqliteWorkerOutcomeUnknown(cause)) {
    throw cause;
  }
  const error = new SqliteWorkerError(message, "outcome-unknown");
  error.cause = cause;
  throw error;
}

export async function withSessionEntryWorker<T>(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string | undefined,
  assertCurrent: () => void,
  run: (
    execution: OpenClawAgentDatabaseExecution,
    source: AgentDatabaseRequestExecutionSource,
    context: SessionEntryCommitContext,
  ) => Promise<T>,
  onCommit?: (
    admission: SqliteWorkerOperationAdmission,
    retained: RetainedWorkerTransactionAdmission,
    facts: unknown,
  ) => void,
  retainedExecution?: OpenClawAgentDatabaseExecution,
  signal?: AbortSignal,
  prepare?: SessionEntryWorkerPreparation,
  onTransaction?: (facts: unknown) => void,
  onAdmission?: (
    admission: SqliteWorkerOperationAdmission,
    retained: RetainedWorkerTransactionAdmission,
    request: SqliteWorkerAdmissionRequest,
    grant: () => boolean,
  ) => boolean,
  releaseSource?: () => void | Promise<void>,
  operationMode: "write" | "prepared-read" = "write",
): Promise<T> {
  let execution: OpenClawAgentDatabaseExecution;
  let env: SessionEntryCommitContext["env"];
  try {
    env = Object.freeze({ ...(options.env ?? process.env) });
    execution =
      retainedExecution ??
      captureOpenClawAgentDatabaseExecution(
        options,
        databaseIdentity
          ? {
              expectedIdentity: {
                kind: "file",
                physicalIdentity: databaseIdentity,
                nativeLocation: options.path,
              },
            }
          : {},
      );
  } catch (error) {
    try {
      await releaseSource?.();
    } catch (cleanupError) {
      throw retainSqliteWorkerErrorCode(
        createSqliteLifecycleAggregateError(
          [error, cleanupError],
          "Session writer acquisition and source cleanup failed",
          error,
        ),
        error,
      );
    }
    throw error;
  }
  const assertRetainedIdentity = () => {
    if (!retainedExecution) {
      return;
    }
    if (!options.env || execution.agentId !== normalizeAgentId(options.agentId)) {
      throw new Error("Session writer differs from its captured database scope");
    }
    const accepted = execution.fileIdentity;
    if (!accepted) {
      if (databaseIdentity !== undefined || execution.path !== options.path) {
        throw new Error("Session writer has no accepted identity for this target");
      }
      return;
    }
    if (databaseIdentity !== undefined && accepted.physicalIdentity !== databaseIdentity) {
      throw new Error("Session writer differs from its original read snapshot");
    }
    assertExistingDatabaseIdentity(
      options.path,
      `file:${accepted.physicalIdentity}`,
      accepted.birthtime,
    );
  };
  let assertNativeCurrent: (() => void) | undefined;
  const context: SessionEntryCommitContext = {
    env,
    assertCurrent() {
      execution.assertCurrent();
      assertRetainedIdentity();
      assertNativeCurrent?.();
    },
  };
  const assertHeld = () => {
    execution.assertCurrent();
    assertCurrent();
    assertRetainedIdentity();
    preparedReadClaim?.assertCurrent();
  };
  let preparedReadClaim: AgentDatabaseGenerationClaim | undefined;
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: assertHeld,
    createAdmission(binding) {
      assertNativeCurrent = () => binding.assertCurrent();
      return (retained) => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          if (operationMode === "prepared-read" && request.stage !== "prepare") {
            throw new Error("Prepared session read cannot open storage or admit a write");
          }
          binding.authorize(request);
          assertHeld();
          if (onAdmission?.(admission, retained, request, grant)) {
            return;
          }
          if (request.stage === "commit") {
            onCommit?.(admission, retained, request.facts);
          } else if (request.stage === "transaction") {
            onTransaction?.(request.facts);
          }
          if (!grant()) {
            throw new Error("Session replacement authority expired");
          }
        }, binding.attachment);
        return { nativeLocations: binding.nativeLocations, admission };
      };
    },
  };
  const withWriterReads = <Value>(
    nativeWorker: AgentDatabaseExecutionScope | undefined,
    consume: () => Promise<Value>,
  ): Promise<Value> => {
    const read = <Read>(operation: (scope: AgentDatabaseExecutionScope) => Promise<Read>) =>
      nativeWorker ? operation(nativeWorker) : execution.runExisting(source, operation);
    return withSessionEntryWriterReads(
      options,
      {
        async entry(scope) {
          const result = await read((worker) =>
            worker.execute({
              type: "session.entry.readResult",
              input: {
                kind: "session-entry-read",
                database: { agentId: options.agentId, path: options.path },
                scope: { ...scope, databaseAgentId: options.agentId },
              },
            }),
          );
          assertHeld();
          if (!result || result.kind !== "session-entry-read") {
            throw new Error("Session entry read lost its active writer");
          }
          return {
            ...(result.readError
              ? err(decodeSessionTranscriptWorkerReadError(result.readError))
              : ok(result.entry)),
            source: result.source,
            facts: result.facts,
          };
        },
        async entries(request) {
          const result = await read((worker) =>
            worker.execute({ type: "session.entry.read", input: request }),
          );
          assertHeld();
          if (!result) {
            throw new Error("Session entry read lost its active writer");
          }
          return result;
        },
      },
      consume,
    );
  };
  let preparation: ReturnType<SessionEntryWorkerPreparation> | undefined;
  let outcome: Result<T, unknown>;
  try {
    if (operationMode === "prepared-read") {
      if (prepare) {
        throw new Error("Prepared session read cannot prepare a writer");
      }
      preparedReadClaim = execution.capturePreparedGenerationClaim();
      if (!preparedReadClaim) {
        throw new Error("Session read lost its prepared native generation");
      }
      assertHeld();
    }
    preparation = prepare?.(execution, source);
    if (preparation) {
      // Cold native admission still owns the writer; snapshot planning releases it.
      const opened = await runOpenClawAgentWorkerWrite(
        options,
        async () => {
          await execution.prepare(source);
          return execution.runExisting(source, async () => true);
        },
        undefined,
        signal,
      );
      if (!opened) {
        throw new Error("Session database disappeared before preparation");
      }
      await preparation.prepare();
    }
    const value =
      operationMode === "prepared-read"
        ? await run(execution, source, context)
        : await runOpenClawAgentWorkerWrite(
            options,
            () => {
              preparation?.beforeWrite();
              const writingExecution: OpenClawAgentDatabaseExecution = {
                ...execution,
                get fileIdentity() {
                  return execution.fileIdentity;
                },
                runExisting(readSource, operation, readOptions) {
                  // Lend the existing scope so a failed read unwinds before native cleanup.
                  return execution.runExisting(
                    readSource,
                    (worker) => withWriterReads(worker, () => operation(worker)),
                    readOptions,
                  );
                },
              };
              return withWriterReads(undefined, () => run(writingExecution, source, context));
            },
            undefined,
            signal,
          );
    if (operationMode === "prepared-read") {
      assertHeld();
    }
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanup of [
    () => releaseSource?.(),
    () => preparation?.release(),
    () => (retainedExecution ? undefined : execution.release()),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (cleanupErrors.length) {
    if (!outcome.ok) {
      throw retainSqliteWorkerErrorCode(
        createSqliteLifecycleAggregateError(
          [outcome.error, ...cleanupErrors],
          "Session mutation and executor cleanup failed",
          outcome.error,
        ),
        outcome.error,
      );
    }
    try {
      getChildLogger({ subsystem: "session-sqlite" }).warn(
        "Session mutation completed before executor cleanup failed",
        { errors: cleanupErrors.map((error) => formatErrorMessage(error)) },
      );
    } catch {
      // Diagnostics cannot make an acknowledged mutation appear replayable.
    }
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

export function prepareSessionEntryReplacementDatabase(
  options: ReplacementDatabaseOptions,
  assertCurrent: () => void,
  retainedExecution?: OpenClawAgentDatabaseExecution,
): Promise<void> {
  return withSessionEntryWorker(
    options,
    undefined,
    assertCurrent,
    (execution, source) => execution.prepare(source),
    undefined,
    retainedExecution,
  );
}

export async function initializeSessionTranscriptInWorker(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  input: { sessionKey: string; sessionId: string; cwd?: string },
  assertCurrent: () => void,
): Promise<void> {
  const publication = retainSessionEntryWorkerPublication({
    agentId: options.agentId,
    storePath: options.path,
    databaseIdentity,
  });
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  await withSessionEntryWorker(
    options,
    databaseIdentity,
    assertCurrent,
    async (execution, source) => {
      const initialized = await execution.runExisting(source, async (worker) => {
        const outcome = await worker.execute({ type: "session.transcript.initialize", input }).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        let unknown = outcome.ok;
        if (admitted) {
          // Join delivery, then drain the native port before reading native completion.
          await admitted.retained.settled;
          const facts = admitted.admission.committed?.facts;
          const placeholder =
            isRecord(facts) &&
            isRecord(facts.placeholder) &&
            typeof facts.placeholder.sessionId === "string"
              ? { sessionId: facts.placeholder.sessionId }
              : undefined;
          let receipt: SessionTranscriptInitializationPublication | undefined = outcome.ok
            ? outcome.value
            : undefined;
          if (
            isRecord(facts) &&
            facts.kind === "session-transcript-initialized" &&
            facts.sessionKey === input.sessionKey &&
            (facts.placeholder === undefined || placeholder?.sessionId === input.sessionId)
          ) {
            receipt = {
              kind: "session-transcript-initialized",
              sessionKey: facts.sessionKey,
              ...(placeholder ? { placeholder } : {}),
              transcriptPublication: parseSessionTranscriptAuthorityReceipts(
                facts.transcriptPublication,
              ),
            };
          }
          unknown = admitted.admission.settlement?.kind !== "completed" || !receipt;
          publication.settle(receipt, unknown);
        }
        if (unknown) {
          rejectUnknownSessionEntryOutcome(
            "Session transcript initialization has no confirmed native completion and commit receipt",
            outcome.ok ? undefined : outcome.error,
          );
        }
        if (!outcome.ok) {
          throw outcome.error;
        }
        return true;
      });
      if (!initialized) {
        throw new Error("Session database disappeared before transcript initialization");
      }
    },
    (admission, retained, facts) => {
      if (
        !isRecord(facts) ||
        !isRecord(facts.publication) ||
        facts.publication.kind !== "session-transcript-initialized" ||
        facts.publication.sessionKey !== input.sessionKey ||
        (facts.publication.placeholder !== undefined &&
          (!isRecord(facts.publication.placeholder) ||
            facts.publication.placeholder.sessionId !== input.sessionId))
      ) {
        throw new Error("Session transcript commit omitted its exact publication facts");
      }
      admitted = { admission, retained };
      publication.begin(
        [input.sessionKey],
        [],
        [],
        [],
        parseSessionTranscriptAuthorityReceipts(facts.publication.transcriptPublication),
      );
    },
  );
}

export type SessionEntryWorkerMutationResult<T> =
  | { kind: "committed"; value: T; publication: SessionEntryReplacementPublication }
  | { kind: "not-committed"; value: T };

export async function runSessionEntryWorkerMutation<T>(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  assertCurrent: () => void,
  run: (worker: AgentDatabaseExecutionScope) => Promise<SessionEntryWorkerMutationResult<T>>,
  lifecycle: {
    identityAgentId: string;
    onResult?: (value: T | undefined) => void;
    afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
  },
  executionOptions: {
    retainedExecution?: OpenClawAgentDatabaseExecution;
    signal?: AbortSignal;
    prepare?: SessionEntryWorkerPreparation;
  } = {},
): Promise<T> {
  const unknownMessage =
    "Session entry mutation has no confirmed native completion and commit receipt";
  const publication = retainSessionEntryWorkerPublication({
    agentId: lifecycle.identityAgentId,
    storePath: options.path,
    databaseIdentity,
  });
  let completed: SessionEntryWorkerMutationResult<T> | undefined;
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  const settle = async () => {
    if (!admitted) {
      if (completed?.kind === "committed") {
        return true;
      }
      if (completed) {
        lifecycle.onResult?.(completed.value);
      }
      return false;
    }
    await admitted.retained.settled;
    const facts = admitted.admission.committed?.facts;
    let receipt: SessionEntryReplacementPublication | undefined;
    if (isRecord(facts) && facts.kind === "session-entry-replacements") {
      // SAFETY: This retained command's paired native kernel owns the tagged publication receipt.
      receipt = facts as SessionEntryReplacementPublication;
    } else if (completed?.kind === "committed") {
      receipt = completed.publication;
    }
    const unknown =
      admitted.admission.settlement?.kind !== "completed" ||
      !receipt ||
      completed?.kind === "not-committed";
    try {
      try {
        if (receipt) {
          lifecycle.onResult?.(completed?.value);
          lifecycle.onLifecycleCommitted?.(receipt.pendingArchiveRecovery);
        }
      } finally {
        // Result adoption precedes observers, but its failure cannot retain publication custody.
        const published = publication.settle(receipt, unknown);
        if (published) {
          publishCommittedSessionIdentity(
            lifecycle.identityAgentId,
            databaseIdentity,
            published.previous,
            published.current,
            published.prepared,
          );
        }
      }
    } catch (error) {
      if (unknown) {
        rejectUnknownSessionEntryOutcome(unknownMessage, error);
      }
      throw error;
    }
    return unknown;
  };
  return await withSessionEntryWorker(
    options,
    databaseIdentity,
    assertCurrent,
    (execution, source, context) =>
      execution
        .runExisting(source, async (worker) => {
          const outcome = await run(worker).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          if (outcome.ok) {
            completed = outcome.value;
          }
          // Keep the executing scope and FIFO writer through native publication settlement.
          // Close joins this callback; a delayed result cannot borrow a successor owner.
          if (await settle()) {
            rejectUnknownSessionEntryOutcome(
              unknownMessage,
              outcome.ok ? undefined : outcome.error,
            );
          }
          if (!outcome.ok) {
            throw outcome.error;
          }
          if (outcome.value.kind === "committed") {
            await lifecycle.afterCommitted?.(context);
          }
          return { value: outcome.value.value };
        })
        .then((result) => {
          if (!result) {
            throw new Error("Session database disappeared before mutation");
          }
          return result.value;
        }),
    (admission, retained, facts) => {
      if (
        !isRecord(facts) ||
        !isRecord(facts.publication) ||
        facts.publication.kind !== "session-entry-replacements" ||
        !Array.isArray(facts.publication.changedKeys) ||
        !facts.publication.changedKeys.every((key): key is string => typeof key === "string") ||
        !Array.isArray(facts.publication.membershipInvalidatedKeys) ||
        !facts.publication.membershipInvalidatedKeys.every(
          (key): key is string => typeof key === "string",
        ) ||
        !Array.isArray(facts.publication.sharingUnchangedKeys) ||
        !facts.publication.sharingUnchangedKeys.every(
          (key): key is string => typeof key === "string",
        ) ||
        !Array.isArray(facts.publication.generationUnchangedKeys) ||
        !facts.publication.generationUnchangedKeys.every(
          (key): key is string => typeof key === "string",
        )
      ) {
        throw new Error("Session entry mutation commit omitted its publication keys");
      }
      admitted = { admission, retained };
      publication.begin(
        facts.publication.changedKeys,
        facts.publication.membershipInvalidatedKeys,
        facts.publication.sharingUnchangedKeys,
        facts.publication.generationUnchangedKeys,
        parseSessionTranscriptAuthorityReceipts(facts.publication.transcriptPublication),
      );
    },
    executionOptions.retainedExecution,
    executionOptions.signal,
    executionOptions.prepare,
  );
}

export function commitSessionEntryReplacementsInWorker(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  input: AgentDatabaseOperations["session.entries.replace"]["input"],
  assertCurrent: () => void,
  lifecycle: {
    identityAgentId: string;
    afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
  },
  retainedExecution?: OpenClawAgentDatabaseExecution,
): Promise<SessionEntryReplacementCommitted> {
  return runSessionEntryWorkerMutation<SessionEntryReplacementCommitted>(
    options,
    databaseIdentity,
    assertCurrent,
    async (worker) => {
      const value = await worker.execute({ type: "session.entries.replace", input });
      return {
        kind: "committed",
        value,
        publication: value.publication,
      };
    },
    lifecycle,
    { retainedExecution },
  );
}
