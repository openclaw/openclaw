import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasSqliteWorkerOutcomeUnknown,
  SqliteWorkerError,
} from "../../infra/sqlite-worker-contract.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { RetainedWorkerTransactionAdmission } from "../../infra/sqlite-worker-operation-settlement.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-contract.js";
import type { AgentDatabaseExecutionScope } from "../../state/openclaw-agent-execution-native.js";
import {
  captureOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "../../state/openclaw-agent-execution.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import {
  retainSessionEntryWorkerPublication,
  type SessionEntryReplacementPublication,
  type SessionTranscriptInitializationPublication,
} from "./session-accessor.sqlite-entry-cache.js";
import { publishCommittedSessionIdentity } from "./session-accessor.sqlite-identity.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type {
  SessionEntryReplacementCommit,
  SessionEntryReplacementCommitted,
} from "./session-accessor.sqlite-replacement-types.js";
import type { SessionEntryCommitContext } from "./session-accessor.types.js";

type ReplacementDatabaseOptions = OpenClawAgentDatabaseOptions & { path: string };

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
): Promise<T> {
  const execution =
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
    env: Object.freeze({ ...(options.env ?? process.env) }),
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
  };
  const source: AgentDatabaseRequestExecutionSource = {
    assertCurrent: assertHeld,
    createAdmission(binding) {
      assertNativeCurrent = () => binding.assertCurrent();
      return (retained) => {
        const admission = createSqliteWorkerOperationAdmission((request, grant) => {
          binding.authorize(request);
          assertHeld();
          if (request.stage === "commit") {
            onCommit?.(admission, retained, request.facts);
          }
          if (!grant()) {
            throw new Error("Session replacement authority expired");
          }
        }, binding.attachment);
        return { nativeLocations: binding.nativeLocations, admission };
      };
    },
  };
  try {
    return await runOpenClawAgentWorkerWrite(
      options,
      () => run(execution, source, context),
      undefined,
      signal,
    );
  } finally {
    if (!retainedExecution) {
      await execution.release();
    }
  }
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
      publication.begin([input.sessionKey], []);
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
    onLifecycleCommitted?: () => void;
  },
  executionOptions: {
    retainedExecution?: OpenClawAgentDatabaseExecution;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const publication = retainSessionEntryWorkerPublication({
    agentId: options.agentId,
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
      if (receipt) {
        lifecycle.onResult?.(completed?.value);
        lifecycle.onLifecycleCommitted?.();
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
        );
      }
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
              "Session entry mutation has no confirmed native completion and commit receipt",
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
        )
      ) {
        throw new Error("Session entry mutation commit omitted its publication keys");
      }
      admitted = { admission, retained };
      publication.begin(facts.publication.changedKeys, facts.publication.membershipInvalidatedKeys);
    },
    executionOptions.retainedExecution,
    executionOptions.signal,
  );
}

export function commitSessionEntryReplacementsInWorker(
  options: ReplacementDatabaseOptions,
  databaseIdentity: string,
  input: SessionEntryReplacementCommit,
  assertCurrent: () => void,
  lifecycle: {
    identityAgentId: string;
    afterCommitted?: (context: SessionEntryCommitContext) => Promise<void>;
    onLifecycleCommitted?: () => void;
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
        publication: prepareSessionEntryReplacementPublication(value),
      };
    },
    lifecycle,
    { retainedExecution },
  );
}
