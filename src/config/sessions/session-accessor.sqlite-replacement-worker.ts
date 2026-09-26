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
import type {
  AgentDatabaseOperations,
  AgentDatabaseRequestExecutionSource,
} from "../../state/openclaw-agent-execution-contract.js";
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
import type { SessionEntryCommitContext } from "./session-accessor.types.js";

type ReplacementDatabaseOptions = OpenClawAgentDatabaseOptions & { path: string };

export function rejectUnknownSessionEntryOutcome(message: string, cause: unknown): never {
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
    return await runOpenClawAgentWorkerWrite(options, () => run(execution, source, context));
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

export function createSessionEntryWorkerCommitPublication(
  options: { agentId: string; path: string },
  databaseIdentity: string,
  identityAgentId: string,
) {
  const publication = retainSessionEntryWorkerPublication({
    agentId: options.agentId,
    storePath: options.path,
    databaseIdentity,
  });
  let admitted:
    | { admission: SqliteWorkerOperationAdmission; retained: RetainedWorkerTransactionAdmission }
    | undefined;
  return {
    begin(
      admission: SqliteWorkerOperationAdmission,
      retained: RetainedWorkerTransactionAdmission,
      facts: unknown,
    ): void {
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
        throw new Error("Session entry commit omitted its publication keys");
      }
      admitted = { admission, retained };
      publication.begin(facts.publication.changedKeys, facts.publication.membershipInvalidatedKeys);
    },
    async settle(
      fallbackReceipt: SessionEntryReplacementPublication | undefined,
      onCommitted?: (receipt: SessionEntryReplacementPublication) => void,
    ): Promise<boolean> {
      if (!admitted) {
        return false;
      }
      await admitted.retained.settled;
      const facts = admitted.admission.committed?.facts;
      let receipt = fallbackReceipt;
      if (isRecord(facts) && facts.kind === "session-entry-replacements") {
        // SAFETY: This retained command's paired native kernel owns the tagged publication receipt.
        receipt = facts as SessionEntryReplacementPublication;
      }
      const unknown = admitted.admission.settlement?.kind !== "completed" || !receipt;
      try {
        if (receipt) {
          onCommitted?.(receipt);
        }
      } finally {
        const published = publication.settle(receipt, unknown);
        if (published) {
          publishCommittedSessionIdentity(
            identityAgentId,
            databaseIdentity,
            published.previous,
            published.current,
          );
        }
      }
      return unknown;
    },
  };
}

export async function commitSessionEntryReplacementsInWorker(
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
) {
  const publication = createSessionEntryWorkerCommitPublication(
    options,
    databaseIdentity,
    lifecycle.identityAgentId,
  );
  let admitted = false;
  return await withSessionEntryWorker(
    options,
    databaseIdentity,
    assertCurrent,
    (execution, source, context) =>
      execution
        .runExisting(source, async (worker) => {
          const outcome = await worker.execute({ type: "session.entries.replace", input }).then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          // Keep the executing scope and FIFO writer through native publication settlement.
          // Close joins this callback; a delayed result cannot borrow a successor owner.
          const unknown = await publication.settle(
            outcome.ok ? prepareSessionEntryReplacementPublication(outcome.value) : undefined,
            (receipt) => lifecycle.onLifecycleCommitted?.(receipt.pendingArchiveRecovery),
          );
          if (unknown || (outcome.ok && !admitted)) {
            rejectUnknownSessionEntryOutcome(
              "Session replacement has no confirmed native completion and commit receipt",
              outcome.ok ? undefined : outcome.error,
            );
          }
          if (!outcome.ok) {
            throw outcome.error;
          }
          await lifecycle.afterCommitted?.(context);
          return outcome.value;
        })
        .then((result) => {
          if (!result) {
            throw new Error("Session database disappeared before replacement");
          }
          return result;
        }),
    (admission, retained, facts) => {
      publication.begin(admission, retained, facts);
      admitted = true;
    },
    retainedExecution,
  );
}
