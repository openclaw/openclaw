import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { retainSqliteWorkerErrorCode } from "../../infra/sqlite-worker-contract.js";
import {
  readDatabasePathIdentitySync,
  type DatabasePathIdentity,
} from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { getChildLogger } from "../../logging/logger.js";
import { assertAgentSessionWriteAdmission } from "../../sessions/session-agent-work-admission.js";
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
import type { captureNativeSessionWorkerDeletion } from "./session-accessor.sqlite-deletion.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import type {
  SessionEntryReplacementCandidate,
  SessionEntryReplacementCommitted,
} from "./session-accessor.sqlite-replacement-types.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";
import { withSessionEntryWriterReads } from "./session-entry-read-facts.js";
import { decodeSessionTranscriptWorkerReadError } from "./session-history-worker-errors.js";
import {
  acceptSessionSourceValidation,
  prepareSessionSourceAuthority,
  releaseSessionSourceAuthorities,
  type SessionSourceAssertion,
  type SessionSourceValidation,
} from "./session-source-authority.js";
import { parseSessionTranscriptAuthorityReceipts } from "./session-transcript-authority.js";
import { throwSessionWorkerOutcomeUnknown } from "./session-worker-receipt.js";

type ReplacementDatabaseOptions = OpenClawAgentDatabaseOptions & { path: string };

export type SessionEntryWorkerPreparation = (
  execution: OpenClawAgentDatabaseExecution,
  source: AgentDatabaseRequestExecutionSource,
) => {
  prepare: () => Promise<void>;
  beforeWrite: () => void;
};

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
  expectedCreationIdentity?: DatabasePathIdentity,
  concurrentBoardReads?: "transcript-only",
): Promise<T> {
  let execution: OpenClawAgentDatabaseExecution;
  let env: SessionEntryCommitContext["env"];
  try {
    if (operationMode === "write") {
      assertAgentSessionWriteAdmission(options);
    }
    env = Object.freeze({ ...(options.env ?? process.env) });
    const targetIdentity =
      !retainedExecution && !databaseIdentity && !expectedCreationIdentity
        ? readDatabasePathIdentitySync(options.path)
        : undefined;
    execution =
      retainedExecution ??
      captureOpenClawAgentDatabaseExecution(options, {
        expectedCreationIdentity: databaseIdentity
          ? undefined
          : (expectedCreationIdentity ??
            (targetIdentity?.key.startsWith("path:") ? targetIdentity : undefined)),
        expectedIdentity: databaseIdentity
          ? {
              kind: "file",
              physicalIdentity: databaseIdentity,
              nativeLocation: options.path,
            }
          : undefined,
      });
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
  let assertNativeCurrent: (() => void) | undefined;
  const context: SessionEntryCommitContext = {
    env,
    assertCurrent() {
      execution.assertCurrent();
      assertNativeCurrent?.();
    },
  };
  const assertHeld = () => {
    if (operationMode === "write") {
      assertAgentSessionWriteAdmission(options);
    }
    execution.assertCurrent();
    assertCurrent();
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
              const writingExecution: OpenClawAgentDatabaseExecution = {
                ...execution,
                get fileIdentity() {
                  return execution.fileIdentity;
                },
                runExisting(readSource, operation, readOptions) {
                  // Lend the existing scope so a failed read unwinds before native cleanup.
                  return execution.runExisting(
                    readSource,
                    (worker) => {
                      preparation?.beforeWrite();
                      return withWriterReads(worker, () => operation(worker));
                    },
                    readOptions,
                  );
                },
              };
              return withWriterReads(undefined, () => run(writingExecution, source, context));
            },
            undefined,
            signal,
            undefined,
            undefined,
            concurrentBoardReads,
          );
    if (operationMode === "prepared-read") {
      assertHeld();
    }
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  const cleanupErrors: unknown[] = [];
  const releaseExecution = retainedExecution ? undefined : () => execution.release();
  for (const cleanup of [releaseSource, releaseExecution]) {
    try {
      await cleanup?.();
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
  followRegistration?: AgentDatabaseRequestExecutionSource["onRegistryChange"],
): Promise<void> {
  const prepared = retainedExecution?.capturePreparedGenerationClaim();
  if (prepared) {
    assertCurrent();
    prepared.assertCurrent();
    return Promise.resolve();
  }
  return withSessionEntryWorker(
    options,
    undefined,
    assertCurrent,
    (execution, source) => execution.prepare({ ...source, onRegistryChange: followRegistration }),
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
          throwSessionWorkerOutcomeUnknown(
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
  databaseIdentity: string | undefined,
  assertCurrent: () => void,
  run: (worker: AgentDatabaseExecutionScope) => Promise<SessionEntryWorkerMutationResult<T>>,
  lifecycle: {
    identityAgentId: string;
    onResult?: (value: T | undefined) => void;
    beforeCommit?: (publication: SessionEntryReplacementPublication) => void;
    afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
  },
  executionOptions: {
    retainedExecution?: OpenClawAgentDatabaseExecution;
    signal?: AbortSignal;
    prepare?: SessionEntryWorkerPreparation;
    onTransaction?: (facts: unknown) => void;
    errors?: { identity: string; unknown: string; missing: string; publication: string };
  } = {},
): Promise<T> {
  const unknownMessage =
    executionOptions.errors?.unknown ??
    "Session entry mutation has no confirmed native completion and commit receipt";
  let publication: ReturnType<typeof retainSessionEntryWorkerPublication> | undefined;
  let completed: SessionEntryWorkerMutationResult<T> | undefined;
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  const settle = async (
    retainedPublication: ReturnType<typeof retainSessionEntryWorkerPublication>,
    identity: string,
  ) => {
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
        const published = retainedPublication.settle(receipt, unknown);
        if (published) {
          publishCommittedSessionIdentity(
            lifecycle.identityAgentId,
            identity,
            published.previous,
            published.current,
            published.prepared,
          );
        }
      }
    } catch (error) {
      if (unknown) {
        throwSessionWorkerOutcomeUnknown(unknownMessage, error);
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
          const identity = databaseIdentity ?? execution.fileIdentity?.physicalIdentity;
          if (!identity) {
            throw new Error(
              executionOptions.errors?.identity ??
                "Session entry mutation has no prepared native database identity",
            );
          }
          publication = retainSessionEntryWorkerPublication({
            agentId: lifecycle.identityAgentId,
            storePath: execution.path,
            databaseIdentity: identity,
          });
          const outcome = await run(worker).then(ok, err<never, unknown>);
          if (outcome.ok) {
            completed = outcome.value;
          }
          // Close joins publication and FIFO scope; late results cannot borrow a successor.
          if (await settle(publication, identity)) {
            throwSessionWorkerOutcomeUnknown(
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
            throw new Error(
              executionOptions.errors?.missing ?? "Session database disappeared before mutation",
            );
          }
          return result.value;
        }),
    (admission, retained, facts) => {
      if (
        !isRecord(facts) ||
        !isRecord(facts.publication) ||
        facts.publication.kind !== "session-entry-replacements" ||
        !publication
      ) {
        throw new Error(
          executionOptions.errors?.publication ??
            "Session entry mutation commit omitted its publication keys",
        );
      }
      // SAFETY: This command's native kernel supplies the typed publication, not external input.
      const committed = facts.publication as SessionEntryReplacementPublication;
      lifecycle.beforeCommit?.(committed);
      admitted = { admission, retained };
      publication.begin(
        committed.changedKeys,
        committed.membershipInvalidatedKeys,
        committed.sharingUnchangedKeys,
        committed.generationUnchangedKeys,
        committed.transcriptPublication,
        new Map(
          [...committed.current].filter(
            ([key]) => !committed.unavailableParticipantKeys?.includes(key),
          ),
        ),
        committed.conversationPublication,
        committed.fullEntries,
      );
    },
    executionOptions.retainedExecution,
    executionOptions.signal,
    executionOptions.prepare,
    executionOptions.onTransaction,
  );
}

export async function commitSessionEntryReplacementsInWorker(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  input: AgentDatabaseOperations["session.entries.replace"]["input"],
  assertCurrent: SessionSourceAssertion,
  lifecycle: {
    identityAgentId: string;
    afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    onLifecycleCommitted?: (pendingArchiveRecovery: boolean) => void;
  },
  retainedExecution?: OpenClawAgentDatabaseExecution,
  nativeDeletion?: ReturnType<typeof captureNativeSessionWorkerDeletion>,
): Promise<SessionEntryReplacementCommitted> {
  const source = await prepareSessionSourceAuthority(assertCurrent);
  const sameStore = source.checks.every(
    ({ predicate }) => predicate.source.databaseIdentity === databaseIdentity,
  );
  const guardedInput = sameStore
    ? { ...input, sources: source.checks.map(({ predicate }) => predicate) }
    : input;
  const acceptValidation = (facts: unknown) => {
    if (isRecord(facts) && facts.kind === "session-entry-replacements-validated") {
      // SAFETY: The paired replacement kernel supplies this transaction's source comparison.
      acceptSessionSourceValidation(source, facts.sourceValidation as SessionSourceValidation);
      source.assertCurrent();
      return true;
    }
    return false;
  };
  const failures: unknown[] = [];
  try {
    if (nativeDeletion) {
      const { runSessionNativeBindingWorkerOperation } =
        await import("./session-native-binding.js");
      return await runSessionNativeBindingWorkerOperation<
        SessionEntryReplacementCandidate,
        SessionEntryReplacementCommitted
      >({
        database: options,
        databaseIdentity,
        agentId: lifecycle.identityAgentId,
        retainedExecution,
        assertCurrent: source.assertCurrent,
        captured: nativeDeletion,
        entries: nativeDeletion.participants.map(({ sessionKey, entry }) => ({
          sessionKey,
          entry,
        })),
        candidateKind: "session-entry-replacements",
        execute: (worker, nativeBindings) =>
          worker.execute({
            type: "session.entries.replace",
            input: { ...guardedInput, nativeBindings },
          }),
        onTransactionFacts: acceptValidation,
        async onCommitted(candidate, published, identity, context) {
          try {
            lifecycle.onLifecycleCommitted?.(candidate.result.pendingArchiveRecovery);
          } finally {
            if (published) {
              publishCommittedSessionIdentity(
                lifecycle.identityAgentId,
                identity,
                published.previous,
                published.current,
                published.prepared,
              );
            }
          }
          await lifecycle.afterCommitted?.(context);
          return candidate.result;
        },
      });
    }
    return await runSessionEntryWorkerMutation<SessionEntryReplacementCommitted>(
      options,
      databaseIdentity,
      source.assertCurrent,
      async (worker) => {
        const value = await worker.execute({
          type: "session.entries.replace",
          input: guardedInput,
        });
        if ("kind" in value) {
          throw new Error("Session replacement returned an unexpected native binding receipt");
        }
        return { kind: "committed", value, publication: value.publication };
      },
      lifecycle,
      {
        retainedExecution,
        onTransaction: (facts) => {
          if (isRecord(facts)) {
            acceptValidation(facts.publication);
          }
        },
      },
    );
  } catch (error) {
    failures.push(error);
    throw error;
  } finally {
    await releaseSessionSourceAuthorities([source], failures);
  }
}
